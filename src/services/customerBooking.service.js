import {
  COLLECTIONS,
  getBookingsCollection,
  getPaymentsCollection,
} from "../models/collections.js";
import { ApiError } from "../utils/ApiError.js";
import {
  validateRentalListQuery,
  validateRentalObjectIdParam,
} from "../validators/rentalQuery.validator.js";
import { normalizeUserIdentifier } from "../validators/validationHelpers.js";
import {
  buildUserIdMatchCandidates,
  executeRentalListAggregation,
  formatRoleRentalRecord,
} from "./rentalAggregation.service.js";

/**
 * Factory creating Customer rental listing and details services scoped strictly to `req.user.id`.
 */
export function createCustomerBookingService({
  bookingsCollectionGetter = getBookingsCollection,
  paymentsCollectionGetter = getPaymentsCollection,
} = {}) {
  return {
    async listCustomerBookings({ customerId, query = {} }) {
      const normalizedCustomerId = normalizeUserIdentifier(customerId, "customerId");
      const validatedQuery = validateRentalListQuery(query, {
        allowEquipmentFilter: false,
        allowCustomerFilter: false,
        allowOwnerFilter: false,
      });

      const bookingsCollection = await bookingsCollectionGetter();
      const idCandidates = buildUserIdMatchCandidates(normalizedCustomerId);
      const customerEarlyMatch =
        idCandidates.length === 1
          ? { customerId: idCandidates[0] }
          : { $or: idCandidates.map((val) => ({ customerId: val })) };

      const { docs, pagination } = await executeRentalListAggregation({
        bookingsCollection,
        earlyMatch: customerEarlyMatch,
        validatedQuery,
      });

      return {
        items: docs
          .map((doc) =>
            formatRoleRentalRecord(doc, { role: "Customer", detailed: false })
          )
          .filter(Boolean),
        pagination,
      };
    },

    async getCustomerBookingDetails({ customerId, bookingId }) {
      const normalizedCustomerId = normalizeUserIdentifier(customerId, "customerId");
      const bookingObjectId = validateRentalObjectIdParam(
        bookingId,
        "Invalid booking ID"
      );

      const [bookingsCollection] = await Promise.all([
        bookingsCollectionGetter(),
        paymentsCollectionGetter().catch(() => null),
      ]);

      const idCandidates = buildUserIdMatchCandidates(normalizedCustomerId);
      const matchFilter =
        idCandidates.length === 1
          ? { _id: bookingObjectId, customerId: idCandidates[0] }
          : {
              _id: bookingObjectId,
              $or: idCandidates.map((val) => ({ customerId: val })),
            };

      const pipeline = [
        {
          $match: matchFilter,
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
              rentalType: "$equipmentDoc.rentalType",
            },
            paymentDocs: 1,
          },
        },
        { $limit: 1 },
      ];

      const docs = await bookingsCollection.aggregate(pipeline).toArray();
      if (!docs || docs.length === 0) {
        throw new ApiError("Booking not found", 404, { code: "NOT_FOUND" });
      }

      return formatRoleRentalRecord(docs[0], {
        role: "Customer",
        detailed: true,
      });
    },
  };
}

export const customerBookingService = createCustomerBookingService();
