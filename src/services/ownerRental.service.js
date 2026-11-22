import {
  COLLECTIONS,
  getBookingsCollection,
  getEquipmentCollection,
  getUsersCollection,
} from "../models/collections.js";
import { ApiError } from "../utils/ApiError.js";
import {
  validateRentalListQuery,
  validateRentalObjectIdParam,
} from "../validators/rentalQuery.validator.js";
import { normalizeUserIdentifier } from "../validators/validationHelpers.js";
import {
  buildOwnerMatchVariants,
  executeRentalListAggregation,
  formatRoleRentalRecord,
  hydrateRentalUsersByIds,
} from "./rentalAggregation.service.js";

/**
 * Factory creating Owner rental listing and detail inspection services,
 * strictly enforcing that bookings relate only to equipment owned by `req.user.id`.
 */
export function createOwnerRentalService({
  bookingsCollectionGetter = getBookingsCollection,
  equipmentCollectionGetter = getEquipmentCollection,
  usersCollectionGetter = getUsersCollection,
} = {}) {
  async function resolveOwnerEarlyMatch(ownerId, equipmentCollection) {
    const ownerVariants = buildOwnerMatchVariants(ownerId);
    const ownedEqDocs = await equipmentCollection
      .find({ $or: ownerVariants }, { projection: { _id: 1 } })
      .toArray();
    const ownedEqIds = ownedEqDocs.map((d) => d._id).filter(Boolean);

    if (ownedEqIds.length === 0) {
      return { $or: ownerVariants };
    }
    return {
      $or: [...ownerVariants, { equipmentId: { $in: ownedEqIds } }],
    };
  }

  return {
    async listOwnerRentals({ ownerId, query = {} }) {
      const normalizedOwnerId = normalizeUserIdentifier(ownerId, "ownerId");
      const validatedQuery = validateRentalListQuery(query, {
        allowEquipmentFilter: true,
        allowCustomerFilter: false,
        allowOwnerFilter: false,
      });

      const [bookingsCollection, equipmentCollection, usersCollection] =
        await Promise.all([
          bookingsCollectionGetter(),
          equipmentCollectionGetter(),
          usersCollectionGetter(),
        ]);

      const earlyMatch = await resolveOwnerEarlyMatch(
        normalizedOwnerId,
        equipmentCollection
      );

      const { docs, userMap, summary, pagination } =
        await executeRentalListAggregation({
          bookingsCollection,
          usersCollection,
          earlyMatch,
          validatedQuery,
          includeCustomerSearch: true,
          includeOwnerSearch: false,
          hydrateCustomer: true,
          hydrateOwner: false,
          includeSummary: true,
        });

      return {
        items: docs
          .map((doc) =>
            formatRoleRentalRecord(doc, {
              role: "Owner",
              userMap,
              detailed: false,
            })
          )
          .filter(Boolean),
        pagination,
        summary,
      };
    },

    async getOwnerRentalDetails({ ownerId, rentalId }) {
      const normalizedOwnerId = normalizeUserIdentifier(ownerId, "ownerId");
      const rentalObjectId = validateRentalObjectIdParam(
        rentalId,
        "Invalid rental ID"
      );

      const [bookingsCollection, equipmentCollection, usersCollection] =
        await Promise.all([
          bookingsCollectionGetter(),
          equipmentCollectionGetter(),
          usersCollectionGetter(),
        ]);

      const earlyMatch = await resolveOwnerEarlyMatch(
        normalizedOwnerId,
        equipmentCollection
      );

      const pipeline = [
        {
          $match: {
            $and: [{ _id: rentalObjectId }, earlyMatch],
          },
        },
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
              ownerId: "$equipmentDoc.ownerId",
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
      // Defense-in-depth: confirm equipment or booking ownership matches authenticated Owner
      const eqOwnerMatches =
        doc.equipmentDoc?.ownerId !== undefined &&
        String(doc.equipmentDoc.ownerId) === normalizedOwnerId;
      const bookingOwnerMatches = String(doc.ownerId || "") === normalizedOwnerId;
      if (!eqOwnerMatches && !bookingOwnerMatches) {
        throw new ApiError("Rental record not found", 404, { code: "NOT_FOUND" });
      }

      const userMap = await hydrateRentalUsersByIds(usersCollection, [
        doc.customerId,
      ]);

      return formatRoleRentalRecord(doc, {
        role: "Owner",
        userMap,
        detailed: true,
      });
    },
  };
}

export const ownerRentalService = createOwnerRentalService();
