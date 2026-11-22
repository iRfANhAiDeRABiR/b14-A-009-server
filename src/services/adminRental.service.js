import {
  COLLECTIONS,
  getBookingsCollection,
  getUsersCollection,
} from "../models/collections.js";
import { ApiError } from "../utils/ApiError.js";
import {
  validateRentalListQuery,
  validateRentalObjectIdParam,
} from "../validators/rentalQuery.validator.js";
import { cleanString } from "../validators/validationHelpers.js";
import { recordAuditEventSafe } from "./auditLog.service.js";
import {
  executeRentalListAggregation,
  formatRoleRentalRecord,
  hydrateRentalUsersByIds,
} from "./rentalAggregation.service.js";

/**
 * Factory creating Admin platform-wide rental monitoring, inspection, and governance note services.
 * Intentionally keeps booking/payment statuses governed by Stripe webhook fulfillment.
 */
export function createAdminRentalService({
  bookingsCollectionGetter = getBookingsCollection,
  usersCollectionGetter = getUsersCollection,
  auditLogger = recordAuditEventSafe,
  nowProvider = () => new Date(),
} = {}) {
  return {
    async listAdminRentals({ query = {} }) {
      const validatedQuery = validateRentalListQuery(query, {
        allowEquipmentFilter: true,
        allowCustomerFilter: true,
        allowOwnerFilter: true,
      });

      const [bookingsCollection, usersCollection] = await Promise.all([
        bookingsCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const { docs, userMap, pagination } = await executeRentalListAggregation({
        bookingsCollection,
        usersCollection,
        earlyMatch: {},
        validatedQuery,
        includeCustomerSearch: true,
        includeOwnerSearch: true,
        hydrateCustomer: true,
        hydrateOwner: true,
        includeSummary: false,
      });

      return {
        items: docs
          .map((doc) =>
            formatRoleRentalRecord(doc, {
              role: "Admin",
              userMap,
              detailed: false,
            })
          )
          .filter(Boolean),
        pagination,
      };
    },

    async getAdminRentalDetails({ rentalId }) {
      const rentalObjectId = validateRentalObjectIdParam(
        rentalId,
        "Invalid rental ID"
      );

      const [bookingsCollection, usersCollection] = await Promise.all([
        bookingsCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const pipeline = [
        { $match: { _id: rentalObjectId } },
        {
          $lookup: {
            from: COLLECTIONS.EQUIPMENT,
            localField: "equipmentId",
            foreignField: "_id",
            as: "equipmentDoc",
          },
        },
        {
          $unwind: {
            path: "$equipmentDoc",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: COLLECTIONS.PAYMENTS,
            localField: "_id",
            foreignField: "bookingId",
            as: "paymentDocs",
          },
        },
        {
          $project: {
            _id: 1,
            customerId: 1,
            ownerId: 1,
            equipmentId: 1,
            startDate: 1,
            endDate: 1,
            quantity: 1,
            contactNumber: 1,
            deliveryAddress: 1,
            additionalNotes: 1,
            rentalType: 1,
            rentalPrice: 1,
            totalAmount: 1,
            currency: 1,
            paymentStatus: 1,
            bookingStatus: 1,
            createdAt: 1,
            equipmentDoc: {
              _id: "$equipmentDoc._id",
              name: "$equipmentDoc.name",
              image: "$equipmentDoc.image",
              category: "$equipmentDoc.category",
              location: "$equipmentDoc.location",
              rentalType: "$equipmentDoc.rentalType",
            },
            paymentDocs: 1,
          },
        },
        { $limit: 1 },
      ];

      const docs = await bookingsCollection.aggregate(pipeline).toArray();
      if (!docs || docs.length === 0) {
        throw new ApiError("Rental record not found", 404, { code: "NOT_FOUND" });
      }

      const doc = docs[0];
      const userMap = await hydrateRentalUsersByIds(usersCollection, [
        doc.customerId,
        doc.ownerId,
      ]);

      const record = formatRoleRentalRecord(doc, {
        role: "Admin",
        userMap,
        detailed: true,
      });
      if (record && typeof doc.adminNote === "string") {
        record.adminNote = doc.adminNote;
      }
      return record;
    },

    async updateAdminRentalNote({ rentalId, body, adminUser }) {
      const rentalObjectId = validateRentalObjectIdParam(
        rentalId,
        "Invalid rental ID"
      );

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError("Invalid request payload", 400, {
          code: "VALIDATION_ERROR",
        });
      }

      const disallowed = Object.keys(body).filter((k) => k !== "adminNote");
      if (disallowed.length > 0) {
        throw new ApiError(
          `Only adminNote can be updated on this endpoint.`,
          400,
          { code: "VALIDATION_ERROR" }
        );
      }

      if (typeof body.adminNote !== "string") {
        throw new ApiError("adminNote must be text.", 400, {
          code: "VALIDATION_ERROR",
        });
      }

      const adminNote = cleanString(body.adminNote);
      if (adminNote.length > 500) {
        throw new ApiError("adminNote cannot exceed 500 characters.", 400, {
          code: "VALIDATION_ERROR",
        });
      }

      const bookingsCollection = await bookingsCollectionGetter();
      const existing = await bookingsCollection.findOne({ _id: rentalObjectId });
      if (!existing) {
        throw new ApiError("Rental record not found", 404, { code: "NOT_FOUND" });
      }

      const now = nowProvider();
      await bookingsCollection.updateOne(
        { _id: rentalObjectId },
        {
          $set: {
            adminNote,
            adminNoteUpdatedAt: now,
            adminNoteUpdatedBy: adminUser?.id || "",
            updatedAt: now,
          },
        }
      );

      await auditLogger({
        action: "RENTAL_NOTE_UPDATED",
        category: "rental",
        severity: "info",
        summary: `Updated internal governance note on rental #${String(rentalObjectId).slice(-6).toUpperCase()}`,
        actor: adminUser,
        target: {
          type: "rental",
          id: String(rentalObjectId),
          label: `Rental #${String(rentalObjectId).slice(-6).toUpperCase()}`,
        },
        metadata: {
          hasNote: Boolean(adminNote),
        },
      });

      return this.getAdminRentalDetails({ rentalId: String(rentalObjectId) });
    },
  };
}

export const adminRentalService = createAdminRentalService();
