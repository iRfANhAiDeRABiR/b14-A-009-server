import { BOOKING_INTENT_STATUSES } from "../constants/booking.js";
import { EQUIPMENT_STATUSES } from "../constants/equipment.js";
import { getClient } from "../config/db.js";
import { env, redactMongoUri } from "../config/env.js";
import {
  COLLECTIONS,
  getBookingIntentsCollection,
  getBookingsCollection,
  getEquipmentCollection,
  getPaymentsCollection,
  getUsersCollection,
} from "../models/collections.js";
import {
  buildBookingIntentDocument,
  formatCustomerBookingRecord,
  sanitizeBookingIntentResponse,
} from "../models/bookingIntent.model.js";
import { buildUserLookupFilter } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { escapeRegexInput } from "../utils/regex.js";
import { calculateReservationExpiration } from "../utils/rentalDate.js";
import {
  validateAvailabilityCheckPayload,
  validateBookingIdParam,
  validateCreateBookingPayload,
  validateCustomerBookingsQuery,
} from "../validators/booking.validator.js";
import { normalizeUserIdentifier } from "../validators/validationHelpers.js";
import { calculateOverlappingReservedQuantity } from "./availability.service.js";
import { calculateAuthoritativeRentalPricing } from "./rentalPricing.service.js";

const TX_OPTIONS = Object.freeze({
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
});

function mapTransactionInfrastructureError(error) {
  if (error instanceof ApiError) {
    return error;
  }

  const rawMsg = String(error?.message || "");
  if (
    error?.code === 20 ||
    error?.codeName === "IllegalOperation" ||
    /replica set|Transaction numbers are only allowed/i.test(rawMsg)
  ) {
    return new ApiError(
      "Booking reservations require a MongoDB replica set supporting multi-document transactions.",
      503,
      { code: "TRANSACTIONS_REQUIRED", isOperational: true }
    );
  }

  const safeMsg = redactMongoUri(rawMsg || "Transaction failed");
  return new ApiError(
    `Unable to complete booking reservation safely: ${safeMsg}`,
    500,
    { code: "BOOKING_TRANSACTION_FAILED", isOperational: true }
  );
}

/**
 * Factory creating concurrency-safe MongoDB booking reservation and query services.
 */
export function createBookingService({
  equipmentCollectionGetter = getEquipmentCollection,
  bookingsCollectionGetter = getBookingsCollection,
  bookingIntentsCollectionGetter = getBookingIntentsCollection,
  usersCollectionGetter = getUsersCollection,
  paymentsCollectionGetter = getPaymentsCollection,
  mongoClientGetter = getClient,
  nowProvider = () => new Date(),
  holdMinutes = env.bookingHoldMinutes,
  transactionsEnabled = env.mongodbTransactions,
} = {}) {
  async function executeBookingTransaction(work) {
    if (!transactionsEnabled) {
      throw new ApiError(
        "Transactional booking reservations are disabled in configuration. A MongoDB replica set with transactions enabled is required.",
        503,
        { code: "TRANSACTIONS_UNAVAILABLE" }
      );
    }

    const client = mongoClientGetter();
    if (!client || typeof client.startSession !== "function") {
      throw new ApiError(
        "Booking reservations require a MongoDB replica set supporting multi-document transactions.",
        503,
        { code: "TRANSACTIONS_REQUIRED" }
      );
    }

    const session = client.startSession();
    try {
      return await session.withTransaction(async () => work(session), TX_OPTIONS);
    } catch (error) {
      throw mapTransactionInfrastructureError(error);
    } finally {
      await session.endSession().catch(() => null);
    }
  }

  return {
    async checkAvailability({ payload }) {
      const now = nowProvider();
      const validated = validateAvailabilityCheckPayload(payload, { now });

      const [equipmentCollection, bookingsCollection, bookingIntentsCollection] =
        await Promise.all([
          equipmentCollectionGetter(),
          bookingsCollectionGetter(),
          bookingIntentsCollectionGetter(),
        ]);

      const equipment = await equipmentCollection.findOne({
        _id: validated.equipmentId,
      });

      if (!equipment) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      if (equipment.status !== EQUIPMENT_STATUSES.APPROVED) {
        throw new ApiError(
          "This equipment is not currently available for booking",
          409,
          { code: "EQUIPMENT_NOT_APPROVED" }
        );
      }

      const availability = await calculateOverlappingReservedQuantity({
        equipment,
        startDate: validated.startDate,
        endDate: validated.endDate,
        bookingsCollection,
        bookingIntentsCollection,
        now,
      });

      return {
        available: validated.quantity <= availability.remainingQuantity,
        equipmentId: String(equipment._id),
        requestedQuantity: validated.quantity,
        totalQuantity: availability.totalQuantity,
        reservedQuantity: availability.reservedQuantity,
        remainingQuantity: availability.remainingQuantity,
      };
    },

    async createBookingReservation({ customerId, payload }) {
      const normalizedCustomerId = normalizeUserIdentifier(customerId, "customerId");
      const now = nowProvider();
      const validated = validateCreateBookingPayload(payload, { now });

      const [
        equipmentCollection,
        usersCollection,
        bookingsCollection,
        bookingIntentsCollection,
      ] = await Promise.all([
        equipmentCollectionGetter(),
        usersCollectionGetter(),
        bookingsCollectionGetter(),
        bookingIntentsCollectionGetter(),
      ]);

      return executeBookingTransaction(async (session) => {
        const txNow = nowProvider();

        // 1. Read approved equipment inside the transaction
        const equipment = await equipmentCollection.findOne(
          { _id: validated.equipmentId },
          { session }
        );
        if (!equipment) {
          throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
        }
        if (equipment.status !== EQUIPMENT_STATUSES.APPROVED) {
          throw new ApiError(
            "This equipment is not currently available for booking",
            409,
            { code: "EQUIPMENT_NOT_APPROVED" }
          );
        }

        // 2. Verify equipment owner account exists
        const ownerDoc = await usersCollection.findOne(
          buildUserLookupFilter(equipment.ownerId),
          { projection: { _id: 1, id: 1 }, session }
        );
        if (!ownerDoc) {
          throw new ApiError("Equipment owner account is unavailable.", 409, {
            code: "OWNER_UNAVAILABLE",
          });
        }

        // 3. Acquire write-conflict serialization lock on shared equipment document
        const lockUpdate = await equipmentCollection.updateOne(
          { _id: equipment._id, status: EQUIPMENT_STATUSES.APPROVED },
          {
            $inc: { reservationVersion: 1 },
            $set: { lastReservationAttemptAt: txNow },
          },
          { session }
        );
        if (!lockUpdate || lockUpdate.modifiedCount === 0) {
          throw new ApiError(
            "This equipment is not currently available for booking",
            409,
            { code: "EQUIPMENT_NOT_APPROVED" }
          );
        }

        // 4. Mark expired temporary reservations inactive prior to recalculating capacity
        await bookingIntentsCollection.updateMany(
          {
            equipmentId: equipment._id,
            status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
            expiresAt: { $lte: txNow },
          },
          {
            $set: {
              status: BOOKING_INTENT_STATUSES.EXPIRED,
              updatedAt: txNow,
            },
          },
          { session }
        );

        // 5. Return existing active identical hold on duplicate retry without double-reserving stock
        const existingIntent = await bookingIntentsCollection.findOne(
          {
            customerId: normalizedCustomerId,
            equipmentId: equipment._id,
            startDate: validated.startDate,
            endDate: validated.endDate,
            quantity: validated.quantity,
            contactNumber: validated.contactNumber,
            deliveryAddress: validated.deliveryAddress,
            additionalNotes: validated.additionalNotes,
            status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
            expiresAt: { $gt: txNow },
          },
          { session }
        );
        if (existingIntent) {
          return {
            created: false,
            data: sanitizeBookingIntentResponse(existingIntent, equipment.name),
          };
        }

        // 6. Recalculate overlapping capacity across bookings + unexpired holds inside tx
        const availability = await calculateOverlappingReservedQuantity({
          equipment,
          startDate: validated.startDate,
          endDate: validated.endDate,
          bookingsCollection,
          bookingIntentsCollection,
          now: txNow,
          session,
        });

        if (validated.quantity > availability.remainingQuantity) {
          throw new ApiError(
            "Requested quantity is not available for the selected rental period",
            409,
            { code: "INSUFFICIENT_AVAILABILITY" }
          );
        }

        // 7. Independently calculate authoritative pricing from MongoDB equipment record
        const pricing = calculateAuthoritativeRentalPricing({
          equipment,
          inclusiveDays: validated.inclusiveDays,
          quantity: validated.quantity,
        });

        // 8. Persist temporary PendingPayment hold with configured hold expiration
        const expiresAt = calculateReservationExpiration({
          now: txNow,
          holdMinutes,
        });

        const intentDoc = buildBookingIntentDocument({
          customerId: normalizedCustomerId,
          ownerId: equipment.ownerId,
          equipmentId: equipment._id,
          startDate: validated.startDate,
          endDate: validated.endDate,
          quantity: validated.quantity,
          contactNumber: validated.contactNumber,
          deliveryAddress: validated.deliveryAddress,
          additionalNotes: validated.additionalNotes,
          rentalType: pricing.rentalType,
          rentalPrice: pricing.rentalPrice,
          billableUnits: pricing.billableUnits,
          totalAmount: pricing.totalAmount,
          currency: pricing.currency,
          expiresAt,
          now: txNow,
        });

        const insertResult = await bookingIntentsCollection.insertOne(intentDoc, {
          session,
        });

        return {
          created: true,
          data: sanitizeBookingIntentResponse(
            { ...intentDoc, _id: insertResult.insertedId },
            equipment.name
          ),
        };
      });
    },

    async cleanupExpiredBookingIntents({ now = nowProvider() } = {}) {
      const bookingIntentsCollection = await bookingIntentsCollectionGetter();
      const result = await bookingIntentsCollection.updateMany(
        {
          status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
          expiresAt: { $lte: now },
        },
        {
          $set: {
            status: BOOKING_INTENT_STATUSES.EXPIRED,
            updatedAt: now,
          },
        }
      );

      return {
        expiredCount: Number(result?.modifiedCount) || 0,
      };
    },

    async listCustomerBookings({ customerId, query = {} }) {
      const normalizedCustomerId = normalizeUserIdentifier(customerId, "customerId");
      const validatedQuery = validateCustomerBookingsQuery(query);
      const bookingsCollection = await bookingsCollectionGetter();

      const matchStage = { customerId: normalizedCustomerId };
      if (validatedQuery.bookingStatus !== "all") {
        matchStage.bookingStatus = validatedQuery.bookingStatus;
      }
      if (validatedQuery.paymentStatus !== "all") {
        matchStage.paymentStatus = validatedQuery.paymentStatus;
      }

      const pipeline = [
        { $match: matchStage },
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
      ];

      if (validatedQuery.search) {
        const pattern = escapeRegexInput(validatedQuery.search);
        pipeline.push({
          $match: {
            $or: [
              { "equipmentDoc.name": { $regex: pattern, $options: "i" } },
              { "equipmentDoc.category": { $regex: pattern, $options: "i" } },
            ],
          },
        });
      }

      pipeline.push(
        {
          $project: {
            _id: 1,
            equipmentId: 1,
            startDate: 1,
            endDate: 1,
            quantity: 1,
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
          },
        },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            metadata: [{ $count: "total" }],
            items: [
              { $skip: validatedQuery.skip },
              { $limit: validatedQuery.limit },
            ],
          },
        }
      );

      const aggregated = await bookingsCollection.aggregate(pipeline).toArray();
      const facetResult = aggregated[0] || {};
      const totalItems = Number(facetResult.metadata?.[0]?.total) || 0;
      const docs = Array.isArray(facetResult.items) ? facetResult.items : [];

      return {
        items: docs
          .map((doc) => formatCustomerBookingRecord(doc, { detailed: false }))
          .filter(Boolean),
        pagination: {
          currentPage: validatedQuery.page,
          limit: validatedQuery.limit,
          totalItems,
          totalPages:
            totalItems === 0 ? 0 : Math.ceil(totalItems / validatedQuery.limit),
        },
      };
    },

    async getCustomerBookingDetails({ customerId, bookingId }) {
      const normalizedCustomerId = normalizeUserIdentifier(customerId, "customerId");
      const bookingObjectId = validateBookingIdParam(bookingId);

      const [bookingsCollection] = await Promise.all([
        bookingsCollectionGetter(),
        // Ensure payments collection accessor remains part of dependency graph for health/testability
        paymentsCollectionGetter().catch(() => null),
      ]);

      const pipeline = [
        {
          $match: {
            _id: bookingObjectId,
            customerId: normalizedCustomerId,
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
            as: "paymentDoc",
          },
        },
        {
          $unwind: {
            path: "$paymentDoc",
            preserveNullAndEmptyArrays: true,
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
            paymentDoc: {
              stripePaymentIntentId: "$paymentDoc.stripePaymentIntentId",
              paidAt: "$paymentDoc.paidAt",
              status: "$paymentDoc.status",
            },
          },
        },
        { $limit: 1 },
      ];

      const docs = await bookingsCollection.aggregate(pipeline).toArray();
      if (!docs || docs.length === 0) {
        throw new ApiError("Booking not found", 404, { code: "NOT_FOUND" });
      }

      return formatCustomerBookingRecord(docs[0], { detailed: true });
    },
  };
}

export const bookingService = createBookingService();
