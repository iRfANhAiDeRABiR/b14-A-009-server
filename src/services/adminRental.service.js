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
import {
  executeRentalListAggregation,
  formatRoleRentalRecord,
  hydrateRentalUsersByIds,
} from "./rentalAggregation.service.js";

/**
 * Factory creating Admin platform-wide finalized rental monitoring and detail services.
 * Intentionally read-only with respect to booking/payment status transitions since no manual
 * status override policy is established outside verified Stripe fulfillment.
 */
export function createAdminRentalService({
  bookingsCollectionGetter = getBookingsCollection,
  usersCollectionGetter = getUsersCollection,
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

      return formatRoleRentalRecord(doc, {
        role: "Admin",
        userMap,
        detailed: true,
      });
    },
  };
}

export const adminRentalService = createAdminRentalService();
