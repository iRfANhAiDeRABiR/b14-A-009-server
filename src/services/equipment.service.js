import { ObjectId } from "mongodb";

import { EQUIPMENT_STATUSES } from "../constants/equipment.js";
import { USER_ROLES } from "../constants/roles.js";
import {
  getBookingsCollection,
  getEquipmentCollection,
  getFavoritesCollection,
  getPaymentsCollection,
  getUsersCollection,
} from "../models/collections.js";
import {
  SAFE_EQUIPMENT_OWNER_PROJECTION,
  sanitizeEquipmentRecord,
} from "../models/equipment.model.js";
import {
  buildUserLookupFilter,
  resolveUserIdentifier,
} from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import {
  parseEquipmentPaginationQuery,
  validateEquipmentCreatePayload,
  validateEquipmentObjectId,
  validateEquipmentPatchPayload,
} from "../validators/equipment.validator.js";

function buildOwnerIdMatch(ownerId) {
  const clean = String(ownerId || "").trim();
  if (ObjectId.isValid(clean) && new ObjectId(clean).toString() === clean) {
    return { $in: [clean, new ObjectId(clean)] };
  }
  return clean;
}

async function hydrateOwnersByIds(usersCollection, ownerIds) {
  const uniqueIds = [...new Set(ownerIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const orClauses = uniqueIds.flatMap((id) => buildUserLookupFilter(id).$or);
  const ownerDocs = await usersCollection
    .find({ $or: orClauses }, { projection: SAFE_EQUIPMENT_OWNER_PROJECTION })
    .toArray();

  const ownerMap = new Map();
  for (const doc of ownerDocs) {
    const resolved = resolveUserIdentifier(doc);
    if (resolved) ownerMap.set(resolved, doc);
    if (doc._id) ownerMap.set(String(doc._id), doc);
    if (doc.id) ownerMap.set(String(doc.id), doc);
  }
  return ownerMap;
}

/**
 * Factory creating equipment lifecycle services with injectable collection getters for testing.
 */
export function createEquipmentService({
  equipmentCollectionGetter = getEquipmentCollection,
  usersCollectionGetter = getUsersCollection,
  bookingsCollectionGetter = getBookingsCollection,
  paymentsCollectionGetter = getPaymentsCollection,
  favoritesCollectionGetter = getFavoritesCollection,
} = {}) {
  return {
    async createEquipment({ ownerId, payload }) {
      const cleanData = validateEquipmentCreatePayload(payload);
      const usersCollection = await usersCollectionGetter();
      const ownerDoc = await usersCollection.findOne(
        buildUserLookupFilter(ownerId),
        { projection: SAFE_EQUIPMENT_OWNER_PROJECTION }
      );

      if (!ownerDoc) {
        throw new ApiError("Authenticated owner account not found", 401, {
          code: "USER_NOT_FOUND",
        });
      }

      const now = new Date();
      const docToInsert = {
        ...cleanData,
        ownerId: String(ownerId),
        status: EQUIPMENT_STATUSES.PENDING,
        createdAt: now,
        updatedAt: now,
      };

      const equipmentCollection = await equipmentCollectionGetter();
      const insertResult = await equipmentCollection.insertOne(docToInsert);
      const createdDoc = {
        ...docToInsert,
        _id: insertResult?.insertedId || docToInsert._id,
      };

      return sanitizeEquipmentRecord(createdDoc, ownerDoc);
    },

    async getFeaturedEquipment({ limit } = {}) {
      let safeLimit = 6;
      if (limit !== undefined && limit !== null && String(limit).trim() !== "") {
        const parsed = Number(limit);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new ApiError("limit must be a positive integer.", 400, {
            code: "VALIDATION_ERROR",
          });
        }
        safeLimit = Math.min(6, parsed);
      }

      const [equipmentCollection, usersCollection] = await Promise.all([
        equipmentCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const docs = await equipmentCollection
        .find({ status: EQUIPMENT_STATUSES.APPROVED })
        .sort({ createdAt: -1, _id: -1 })
        .limit(safeLimit)
        .toArray();

      const ownerMap = await hydrateOwnersByIds(
        usersCollection,
        docs.map((item) => item.ownerId)
      );

      return docs.map((doc) =>
        sanitizeEquipmentRecord(doc, ownerMap.get(String(doc.ownerId)) || null)
      );
    },

    async listPublicApprovedEquipment(rawQuery = {}) {
      const { page, limit } = parseEquipmentPaginationQuery(rawQuery, {
        defaultLimit: 9,
        maxLimit: 50,
      });
      const skip = (page - 1) * limit;
      const filter = { status: EQUIPMENT_STATUSES.APPROVED };

      const [equipmentCollection, usersCollection] = await Promise.all([
        equipmentCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const [totalItems, docs] = await Promise.all([
        equipmentCollection.countDocuments(filter),
        equipmentCollection
          .find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
      ]);

      const ownerMap = await hydrateOwnersByIds(
        usersCollection,
        docs.map((item) => item.ownerId)
      );

      return {
        items: docs.map((doc) =>
          sanitizeEquipmentRecord(doc, ownerMap.get(String(doc.ownerId)) || null)
        ),
        pagination: {
          currentPage: page,
          limit,
          totalItems,
          totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / limit),
        },
      };
    },

    async listOwnerEquipment({ ownerId, query = {} }) {
      const { page, limit, status } = parseEquipmentPaginationQuery(query, {
        defaultLimit: 10,
        maxLimit: 50,
        allowStatus: true,
      });
      const skip = (page - 1) * limit;
      const baseOwnerFilter = { ownerId: buildOwnerIdMatch(ownerId) };
      const listFilter =
        status !== "all" ? { ...baseOwnerFilter, status } : baseOwnerFilter;

      const equipmentCollection = await equipmentCollectionGetter();

      const [totalItems, docs, totalAll, approvedCount, pendingCount, rejectedCount] =
        await Promise.all([
          equipmentCollection.countDocuments(listFilter),
          equipmentCollection
            .find(listFilter)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
          equipmentCollection.countDocuments(baseOwnerFilter),
          equipmentCollection.countDocuments({
            ...baseOwnerFilter,
            status: EQUIPMENT_STATUSES.APPROVED,
          }),
          equipmentCollection.countDocuments({
            ...baseOwnerFilter,
            status: EQUIPMENT_STATUSES.PENDING,
          }),
          equipmentCollection.countDocuments({
            ...baseOwnerFilter,
            status: EQUIPMENT_STATUSES.REJECTED,
          }),
        ]);

      return {
        items: docs.map((doc) => sanitizeEquipmentRecord(doc)),
        pagination: {
          currentPage: page,
          limit,
          totalItems,
          totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / limit),
        },
        summary: {
          total: totalAll,
          approved: approvedCount,
          pending: pendingCount,
          rejected: rejectedCount,
        },
      };
    },

    async getEquipmentDetails({ equipmentId, user }) {
      const objectId = validateEquipmentObjectId(equipmentId);
      const [equipmentCollection, usersCollection] = await Promise.all([
        equipmentCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const doc = await equipmentCollection.findOne({ _id: objectId });
      if (!doc) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      const isApproved = doc.status === EQUIPMENT_STATUSES.APPROVED;
      const isOwnerOfItem =
        user?.role === USER_ROLES.OWNER &&
        String(doc.ownerId) === String(user.id);

      if (!isApproved && !isOwnerOfItem) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      const ownerDoc = await usersCollection.findOne(
        buildUserLookupFilter(doc.ownerId),
        { projection: SAFE_EQUIPMENT_OWNER_PROJECTION }
      );

      return sanitizeEquipmentRecord(doc, ownerDoc);
    },

    async updateOwnerEquipment({ equipmentId, ownerId, payload }) {
      const objectId = validateEquipmentObjectId(equipmentId);
      const patchFields = validateEquipmentPatchPayload(payload);

      const equipmentCollection = await equipmentCollectionGetter();
      const existing = await equipmentCollection.findOne({ _id: objectId });
      if (!existing) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      if (String(existing.ownerId) !== String(ownerId)) {
        throw new ApiError(
          "You do not have permission to update another owner's equipment.",
          403,
          { code: "FORBIDDEN" }
        );
      }

      const updateResult = await equipmentCollection.findOneAndUpdate(
        { _id: objectId, ownerId: existing.ownerId },
        {
          $set: {
            ...patchFields,
            updatedAt: new Date(),
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

      return sanitizeEquipmentRecord(updatedDoc);
    },

    async deleteOwnerEquipment({ equipmentId, ownerId }) {
      const objectId = validateEquipmentObjectId(equipmentId);

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
      if (!existing) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      if (String(existing.ownerId) !== String(ownerId)) {
        throw new ApiError(
          "You do not have permission to delete another owner's equipment.",
          403,
          { code: "FORBIDDEN" }
        );
      }

      const [bookingCount, paymentCount] = await Promise.all([
        bookingsCollection.countDocuments({ equipmentId: existing._id }),
        paymentsCollection.countDocuments({ equipmentId: existing._id }),
      ]);

      if (bookingCount > 0 || paymentCount > 0) {
        throw new ApiError(
          "Equipment cannot be deleted because it has associated rental records",
          409,
          { code: "EQUIPMENT_HAS_BOOKINGS" }
        );
      }

      await equipmentCollection.deleteOne({
        _id: existing._id,
        ownerId: existing.ownerId,
      });

      await favoritesCollection.deleteMany({ equipmentId: existing._id });

      return { deleted: true };
    },
  };
}

export const equipmentService = createEquipmentService();
