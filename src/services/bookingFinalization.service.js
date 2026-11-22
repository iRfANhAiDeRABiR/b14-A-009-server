import { getClient } from "../config/db.js";
import { env, redactMongoUri } from "../config/env.js";
import { BOOKING_INTENT_STATUSES, BOOKING_STATUSES } from "../constants/booking.js";
import { PAYMENT_PROVIDERS, PAYMENT_STATUSES } from "../constants/payment.js";
import {
  getBookingIntentsCollection,
  getBookingsCollection,
  getPaymentsCollection,
  getStripeWebhookEventsCollection,
} from "../models/collections.js";
import { buildStripeWebhookEventDocument } from "../models/stripeWebhookEvent.model.js";
import { ApiError } from "../utils/ApiError.js";

const TX_OPTIONS = Object.freeze({
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
});

function mapWebhookTransactionError(error) {
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
      "Webhook booking finalization requires a MongoDB replica set supporting multi-document transactions.",
      503,
      { code: "TRANSACTIONS_REQUIRED", isOperational: true }
    );
  }

  const safeMsg = redactMongoUri(rawMsg || "Webhook transaction failed");
  console.error(`[Webhook Transaction Error]: ${safeMsg}`);
  return new ApiError("Webhook processing temporarily failed", 500, {
    code: "WEBHOOK_TRANSACTION_FAILED",
    isOperational: true,
  });
}

/**
 * Atomically converts a verified `bookingIntent` into finalized `bookings` + `payments` records
 * and claims the Stripe webhook event ID inside a single MongoDB multi-document transaction.
 */
export function createBookingFinalizationService({
  bookingsCollectionGetter = getBookingsCollection,
  paymentsCollectionGetter = getPaymentsCollection,
  bookingIntentsCollectionGetter = getBookingIntentsCollection,
  webhookEventsCollectionGetter = getStripeWebhookEventsCollection,
  mongoClientGetter = getClient,
  nowProvider = () => new Date(),
  transactionsEnabled = env.mongodbTransactions,
} = {}) {
  async function executeTransaction(work) {
    if (!transactionsEnabled) {
      throw new ApiError(
        "Atomic booking finalization is unavailable because MongoDB transactions are disabled.",
        503,
        { code: "TRANSACTIONS_UNAVAILABLE" }
      );
    }

    const client = mongoClientGetter();
    if (!client || typeof client.startSession !== "function") {
      throw new ApiError(
        "Webhook booking finalization requires a MongoDB replica set supporting multi-document transactions.",
        503,
        { code: "TRANSACTIONS_REQUIRED" }
      );
    }

    const session = client.startSession();
    try {
      return await session.withTransaction(async () => work(session), TX_OPTIONS);
    } catch (error) {
      throw mapWebhookTransactionError(error);
    } finally {
      await session.endSession().catch(() => null);
    }
  }

  return {
    async finalizePaidCheckoutSession({
      eventId,
      eventType,
      bookingIntentId,
      stripeSessionId,
      stripePaymentIntentId = "",
      amountMinor,
      currency,
      paidAt = null,
    }) {
      const [
        bookingsCollection,
        paymentsCollection,
        bookingIntentsCollection,
        webhookEventsCollection,
      ] = await Promise.all([
        bookingsCollectionGetter(),
        paymentsCollectionGetter(),
        bookingIntentsCollectionGetter(),
        webhookEventsCollectionGetter(),
      ]);

      try {
        return await executeTransaction(async (session) => {
          const txNow = nowProvider();

          // STEP 01: Check or claim webhook event ID atomically inside the transaction
          const existingEvent = await webhookEventsCollection.findOne(
            { stripeEventId: eventId },
            { session }
          );
          if (existingEvent?.processed === true) {
            return {
              alreadyProcessed: true,
              status: "duplicate_event",
            };
          }

          let claimedEventId = existingEvent?._id || null;
          if (!claimedEventId) {
            const eventDoc = buildStripeWebhookEventDocument({
              stripeEventId: eventId,
              eventType,
              processed: false,
              bookingIntentId,
              status: "processing",
            });
            const insertedEvent = await webhookEventsCollection.insertOne(eventDoc, {
              session,
            });
            claimedEventId = insertedEvent.insertedId;
          }

          // STEP 02: Read booking intent inside transaction and check prior conversion
          const freshIntent = await bookingIntentsCollection.findOne(
            { _id: bookingIntentId },
            { session }
          );
          if (!freshIntent) {
            throw new ApiError("Booking reservation not found inside transaction", 404, {
              code: "RESERVATION_NOT_FOUND",
            });
          }

          if (freshIntent.status === BOOKING_INTENT_STATUSES.CONVERTED) {
            await webhookEventsCollection.updateOne(
              { _id: claimedEventId },
              {
                $set: {
                  processed: true,
                  status: "already_converted",
                  finalBookingId: freshIntent.finalBookingId || null,
                  paymentId: freshIntent.paymentId || null,
                  processedAt: txNow,
                },
              },
              { session }
            );
            return {
              alreadyProcessed: true,
              status: "already_converted",
              bookingId: freshIntent.finalBookingId
                ? String(freshIntent.finalBookingId)
                : null,
            };
          }

          // STEP 03: Verify no duplicate finalized booking or payment already exists
          const existingBooking = await bookingsCollection.findOne(
            { bookingIntentId: freshIntent._id },
            { session }
          );
          const existingPayment = await paymentsCollection.findOne(
            {
              $or: [
                { stripeCheckoutSessionId: stripeSessionId },
                ...(stripePaymentIntentId
                  ? [{ stripePaymentIntentId }]
                  : []),
              ],
            },
            { session }
          );

          if (existingBooking || existingPayment) {
            await webhookEventsCollection.updateOne(
              { _id: claimedEventId },
              {
                $set: {
                  processed: true,
                  status: "already_converted",
                  finalBookingId: existingBooking?._id || null,
                  paymentId: existingPayment?._id || null,
                  processedAt: txNow,
                },
              },
              { session }
            );
            return {
              alreadyProcessed: true,
              status: "already_converted",
              bookingId: existingBooking?._id ? String(existingBooking._id) : null,
            };
          }

          // STEP 04: Insert finalized confirmed & paid booking
          const finalBookingDoc = {
            bookingIntentId: freshIntent._id,
            customerId: freshIntent.customerId,
            ownerId: freshIntent.ownerId,
            equipmentId: freshIntent.equipmentId,
            startDate: freshIntent.startDate,
            endDate: freshIntent.endDate,
            quantity: freshIntent.quantity,
            contactNumber: freshIntent.contactNumber,
            deliveryAddress: freshIntent.deliveryAddress,
            additionalNotes: freshIntent.additionalNotes || "",
            rentalType: freshIntent.rentalType,
            rentalPrice: freshIntent.rentalPrice,
            billableUnits: freshIntent.billableUnits,
            totalAmount: freshIntent.totalAmount,
            currency: String(currency || freshIntent.currency || "bdt").toLowerCase(),
            paymentStatus: PAYMENT_STATUSES.PAID,
            bookingStatus: BOOKING_STATUSES.CONFIRMED,
            createdAt: txNow,
            updatedAt: txNow,
          };
          const bookingInsert = await bookingsCollection.insertOne(finalBookingDoc, {
            session,
          });

          // STEP 05: Insert verified payment transaction record linked to booking
          const resolvedPaidAt = paidAt instanceof Date ? paidAt : txNow;
          const paymentDoc = {
            bookingId: bookingInsert.insertedId,
            bookingIntentId: freshIntent._id,
            customerId: freshIntent.customerId,
            ownerId: freshIntent.ownerId,
            equipmentId: freshIntent.equipmentId,
            provider: PAYMENT_PROVIDERS.STRIPE,
            stripeCheckoutSessionId: stripeSessionId,
            ...(stripePaymentIntentId ? { stripePaymentIntentId } : {}),
            amount: freshIntent.totalAmount,
            amountMinor,
            currency: String(currency || freshIntent.currency || "bdt").toLowerCase(),
            status: PAYMENT_STATUSES.PAID,
            paidAt: resolvedPaidAt,
            createdAt: txNow,
            updatedAt: txNow,
          };
          const paymentInsert = await paymentsCollection.insertOne(paymentDoc, {
            session,
          });

          // STEP 06: Mark booking intent Converted and remove TTL field so reference persists
          const convertRes = await bookingIntentsCollection.updateOne(
            {
              _id: freshIntent._id,
              status: { $ne: BOOKING_INTENT_STATUSES.CONVERTED },
            },
            {
              $set: {
                status: BOOKING_INTENT_STATUSES.CONVERTED,
                paymentStatus: PAYMENT_STATUSES.PAID,
                finalBookingId: bookingInsert.insertedId,
                paymentId: paymentInsert.insertedId,
                updatedAt: txNow,
              },
              $unset: {
                expiresAt: "",
                checkoutInProgressUntil: "",
              },
            },
            { session }
          );

          if (!convertRes || convertRes.modifiedCount !== 1) {
            throw new Error("Failed to convert booking intent atomically.");
          }

          // STEP 07: Mark webhook event processed atomically inside same transaction
          await webhookEventsCollection.updateOne(
            { _id: claimedEventId },
            {
              $set: {
                processed: true,
                status: "processed",
                finalBookingId: bookingInsert.insertedId,
                paymentId: paymentInsert.insertedId,
                processedAt: txNow,
              },
            },
            { session }
          );

          return {
            alreadyProcessed: false,
            status: "processed",
            bookingId: String(bookingInsert.insertedId),
            paymentId: String(paymentInsert.insertedId),
          };
        });
      } catch (error) {
        if (error?.code === 11000) {
          const [existingEvent, existingBooking] = await Promise.all([
            webhookEventsCollection.findOne({ stripeEventId: eventId }),
            bookingsCollection.findOne({ bookingIntentId }),
          ]);
          if (existingEvent?.processed === true || existingBooking) {
            return {
              alreadyProcessed: true,
              status: "duplicate_event",
              bookingId: existingBooking?._id ? String(existingBooking._id) : null,
            };
          }
        }
        throw error;
      }
    },
  };
}

export const bookingFinalizationService = createBookingFinalizationService();
