import { EQUIPMENT_STATUSES } from "../constants/equipment.js";
import {
  getBookingsCollection,
  getEquipmentCollection,
  getFavoritesCollection,
  getPaymentsCollection,
  getUsersCollection,
} from "../models/collections.js";
import {
  SAFE_ADMIN_EQUIPMENT_OWNER_PROJECTION,
  sanitizeEquipmentRecord,
} from "../models/equipment.model.js";
import {
  buildUserLookupFilter,
  resolveUserIdentifier,
} from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { escapeRegexInput } from "../utils/regex.js";
import {
  validateAdminEquipmentQuery,
  validateAdminRejectPayload,
  validateEquipmentObjectId,
  validateEquipmentPatchPayload,
} from "../validators/adminEquipment.validator.js";
import {
  isValidObjectId,
  normalizeUserIdentifier,
  toObjectId,
} from "../validators/validationHelpers.js";

async function hydrateAdminOwnersMap(usersCollection, ownerIds = []) {
  const uniqueIds = [
    ...new Set(ownerIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ];
  if (uniqueIds.length === 0) return new Map();

  const orClauses = uniqueIds.flatMap((id) => buildUserLookupFilter(id).$or);
  const docs = await usersCollection
    .find(
      { $or: orClauses },
      { projection: SAFE_ADMIN_EQUIPMENT_OWNER_PROJECTION }
    )
    .toArray();

  const map = new Map();
  for (const doc of docs) {
    const resolved = resolveUserIdentifier(doc);
    if (resolved) map.set(resolved, doc);
    if (doc._id !== undefined && doc._id !== null) map.set(String(doc._id), doc);
    if (doc.id !== undefined && doc.id !== null) map.set(String(doc.id), doc);
  }
  return map;
}

async function findMatchingOwnerIdentifiersBySearch(usersCollection, search) {
  const clean = String(search || "").trim();
  if (!clean) return [];

  const rx = { $regex: escapeRegexInput(clean), $options: "i" };
  const matches = await usersCollection
    .find({ $or: [{ name: rx }, { email: rx }] }, { projection: { _id: 1, id: 1 } })
    .toArray();

  const candidates = [];
  for (const doc of matches) {
    const resolved = resolveUserIdentifier(doc);
    if (resolved) candidates.push(resolved);
    if (doc._id !== undefined && doc._id !== null) {
      candidates.push(doc._id, String(doc._id));
    }
    if (doc.id !== undefined && doc.id !== null) {
      candidates.push(String(doc.id));
    }
  }
  return [...new Set(candidates)];
}

/**
 * Factory creating Admin equipment moderation, editing, approval audit, and safe archival/deletion services.
 */
export function createAdminEquipmentService({
  equipmentCollectionGetter = getEquipmentCollection,
  usersCollectionGetter = getUsersCollection,
  bookingsCollectionGetter = getBookingsCollection,
  paymentsCollectionGetter = getPaymentsCollection,
  favoritesCollectionGetter = getFavoritesCollection,
  nowProvider = () => new Date(),
} = {}) {
  return {
    async listAdminEquipment({ query = {} }) {
      const validated = validateAdminEquipmentQuery(query);

      const [equipmentCollection, usersCollection] = await Promise.all([
        equipmentCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const baseFilter = { isDeleted: { $ne: true } };
      if (validated.category !== "all") {
        baseFilter.category = validated.category;
      }
      if (validated.status !== "all") {
        baseFilter.status = validated.status;
      }

      if (validated.search) {
        const pattern = escapeRegexInput(validated.search);
        const rx = { $regex: pattern, $options: "i" };
        const matchedOwnerIds = await findMatchingOwnerIdentifiersBySearch(
          usersCollection,
          validated.search
        );

        const orClauses = [{ name: rx }, { title: rx }];
        if (isValidObjectId(validated.search)) {
          orClauses.push({ _id: toObjectId(validated.search, "id") });
        }
        if (matchedOwnerIds.length > 0) {
          orClauses.push({ ownerId: { $in: matchedOwnerIds } });
        }
        baseFilter.$or = orClauses;
      }

      const [totalItems, docs, totalAll, approvedCount, pendingCount, rejectedCount] =
        await Promise.all([
          equipmentCollection.countDocuments(baseFilter),
          equipmentCollection
            .find(baseFilter)
            .sort(validated.sortOptions)
            .skip(validated.skip)
            .limit(validated.limit)
            .toArray(),
          equipmentCollection.countDocuments({ isDeleted: { $ne: true } }),
          equipmentCollection.countDocuments({
            isDeleted: { $ne: true },
            status: EQUIPMENT_STATUSES.APPROVED,
          }),
          equipmentCollection.countDocuments({
            isDeleted: { $ne: true },
            status: EQUIPMENT_STATUSES.PENDING,
          }),
          equipmentCollection.countDocuments({
            isDeleted: { $ne: true },
            status: EQUIPMENT_STATUSES.REJECTED,
          }),
        ]);

      const ownerMap = await hydrateAdminOwnersMap(
        usersCollection,
        docs.map((item) => item.ownerId)
      );

      return {
        items: docs.map((doc) =>
          sanitizeEquipmentRecord(
            doc,
            ownerMap.get(String(doc.ownerId)) || null,
            { includeAudit: true, includeOwnerEmail: true }
          )
        ),
        pagination: {
          currentPage: validated.page,
          limit: validated.limit,
          totalItems,
          totalPages:
            totalItems === 0 ? 0 : Math.ceil(totalItems / validated.limit),
        },
        summary: {
          total: totalAll,
          approved: approvedCount,
          pending: pendingCount,
          rejected: rejectedCount,
        },
      };
    },

    async getAdminEquipmentDetails({ equipmentId }) {
      const objectId = validateEquipmentObjectId(equipmentId);
      const [equipmentCollection, usersCollection] = await Promise.all([
        equipmentCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const doc = await equipmentCollection.findOne({ _id: objectId });
      if (!doc || doc.isDeleted === true) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      const ownerDoc = await usersCollection.findOne(
        buildUserLookupFilter(doc.ownerId),
        { projection: SAFE_ADMIN_EQUIPMENT_OWNER_PROJECTION }
      );

      return sanitizeEquipmentRecord(doc, ownerDoc, {
        includeAudit: true,
        includeOwnerEmail: true,
      });
    },

    async approveEquipment({ equipmentId, adminId }) {
      const objectId = validateEquipmentObjectId(equipmentId);
      const normalizedAdminId = normalizeUserIdentifier(adminId, "adminId");
      const now = nowProvider();

      const [equipmentCollection, usersCollection] = await Promise.all([
        equipmentCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const existing = await equipmentCollection.findOne({ _id: objectId });
      if (!existing || existing.isDeleted === true) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      const ownerDoc = await usersCollection.findOne(
        buildUserLookupFilter(existing.ownerId),
        { projection: SAFE_ADMIN_EQUIPMENT_OWNER_PROJECTION }
      );

      if (existing.status === EQUIPMENT_STATUSES.APPROVED) {
        return {
          idempotent: true,
          item: sanitizeEquipmentRecord(existing, ownerDoc, {
            includeAudit: true,
            includeOwnerEmail: true,
          }),
        };
      }

      const auditEntry = {
        previousStatus: existing.status,
        newStatus: EQUIPMENT_STATUSES.APPROVED,
        reviewedBy: normalizedAdminId,
        reviewedAt: now,
        rejectionReason: null,
      };

      const updateResult = await equipmentCollection.findOneAndUpdate(
        { _id: objectId, isDeleted: { $ne: true } },
        {
          $set: {
            status: EQUIPMENT_STATUSES.APPROVED,
            reviewedBy: normalizedAdminId,
            reviewedAt: now,
            rejectionReason: null,
            updatedAt: now,
          },
          $push: {
            approvalHistory: auditEntry,
          },
        },
        { returnDocument: "after" }
      );

      const updatedDoc =
        updateResult && typeof updateResult === "object" && "value" in updateResult
          ? updateResult.value
          : updateResult;

      if (!updatedDoc) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      return {
        idempotent: false,
        item: sanitizeEquipmentRecord(updatedDoc, ownerDoc, {
          includeAudit: true,
          includeOwnerEmail: true,
        }),
      };
    },

    async rejectEquipment({ equipmentId, adminId, payload }) {
      const objectId = validateEquipmentObjectId(equipmentId);
      const normalizedAdminId = normalizeUserIdentifier(adminId, "adminId");
      const { rejectionReason } = validateAdminRejectPayload(payload);
      const now = nowProvider();

      const [equipmentCollection, usersCollection] = await Promise.all([
        equipmentCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const existing = await equipmentCollection.findOne({ _id: objectId });
      if (!existing || existing.isDeleted === true) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      const ownerDoc = await usersCollection.findOne(
        buildUserLookupFilter(existing.ownerId),
        { projection: SAFE_ADMIN_EQUIPMENT_OWNER_PROJECTION }
      );

      if (
        existing.status === EQUIPMENT_STATUSES.REJECTED &&
        existing.rejectionReason === rejectionReason
      ) {
        return {
          idempotent: true,
          item: sanitizeEquipmentRecord(existing, ownerDoc, {
            includeAudit: true,
            includeOwnerEmail: true,
          }),
        };
      }

      const auditEntry = {
        previousStatus: existing.status,
        newStatus: EQUIPMENT_STATUSES.REJECTED,
        reviewedBy: normalizedAdminId,
        reviewedAt: now,
        rejectionReason,
      };

      const updateResult = await equipmentCollection.findOneAndUpdate(
        { _id: objectId, isDeleted: { $ne: true } },
        {
          $set: {
            status: EQUIPMENT_STATUSES.REJECTED,
            rejectionReason,
            reviewedBy: normalizedAdminId,
            reviewedAt: now,
            updatedAt: now,
          },
          $push: {
            approvalHistory: auditEntry,
          },
        },
        { returnDocument: "after" }
      );

      const updatedDoc =
        updateResult && typeof updateResult === "object" && "value" in updateResult
          ? updateResult.value
          : updateResult;

      if (!updatedDoc) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      return {
        idempotent: false,
        item: sanitizeEquipmentRecord(updatedDoc, ownerDoc, {
          includeAudit: true,
          includeOwnerEmail: true,
        }),
      };
    },

    async updateAdminEquipment({ equipmentId, payload }) {
      const objectId = validateEquipmentObjectId(equipmentId);
      // Reuses explicit 12-field allowlist blocking ownerId, status, reviewedBy, reviewedAt & history tampering
      const patchFields = validateEquipmentPatchPayload(payload);
      const now = nowProvider();

      const [equipmentCollection, usersCollection] = await Promise.all([
        equipmentCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const existing = await equipmentCollection.findOne({ _id: objectId });
      if (!existing || existing.isDeleted === true) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      const updateResult = await equipmentCollection.findOneAndUpdate(
        { _id: objectId, isDeleted: { $ne: true } },
        {
          $set: {
            ...patchFields,
            updatedAt: now,
          },
        },
        { returnDocument: "after" }
      );

      const updatedDoc =
        updateResult && typeof updateResult === "object" && "value" in updateResult
          ? updateResult.value
          : updateResult;

      if (!updatedDoc) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      const ownerDoc = await usersCollection.findOne(
        buildUserLookupFilter(updatedDoc.ownerId),
        { projection: SAFE_ADMIN_EQUIPMENT_OWNER_PROJECTION }
      );

      return sanitizeEquipmentRecord(updatedDoc, ownerDoc, {
        includeAudit: true,
        includeOwnerEmail: true,
      });
    },

    async deleteAdminEquipment({ equipmentId, adminId }) {
      const objectId = validateEquipmentObjectId(equipmentId);
      const normalizedAdminId = normalizeUserIdentifier(adminId, "adminId");
      const now = nowProvider();

      const [
        equipmentCollection,
        bookingsCollection,
        paymentsCollection,
        favoritesCollection,
      ] = await Promise.all([
        equipmentCollectionGetter(),
        bookingsCollectionGetter(),
        paymentsCollectionGetter(),
        favoritesCollectionGetter(),
      ]);

      const existing = await equipmentCollection.findOne({ _id: objectId });
      if (!existing || existing.isDeleted === true) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      const [bookingCount, paymentCount] = await Promise.all([
        bookingsCollection.countDocuments({ equipmentId: existing._id }),
        paymentsCollection.countDocuments({ equipmentId: existing._id }),
      ]);

      if (bookingCount > 0 || paymentCount > 0) {
        // Preserve historical booking/payment references by soft-archiving safely
        await equipmentCollection.updateOne(
          { _id: existing._id },
          {
            $set: {
              isDeleted: true,
              deletedAt: now,
              deletedBy: normalizedAdminId,
              updatedAt: now,
            },
          }
        );
        await favoritesCollection.deleteMany({ equipmentId: existing._id });

        return {
          deleted: false,
          archived: true,
          equipmentId: String(existing._id),
          message:
            "Equipment archived safely while preserving historical booking and payment records",
        };
      }

      await equipmentCollection.deleteOne({ _id: existing._id });
      await favoritesCollection.deleteMany({ equipmentId: existing._id });

      return {
        deleted: true,
        archived: false,
        equipmentId: String(existing._id),
        message: "Equipment deleted successfully",
      };
    },
  };
}

export const adminEquipmentService = createAdminEquipmentService();
