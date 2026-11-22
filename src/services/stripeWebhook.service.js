import { BOOKING_INTENT_STATUSES } from "../constants/booking.js";
import { PAYMENT_STATUSES } from "../constants/payment.js";
import { redactMongoUri } from "../config/env.js";
import {
  getStripeClient,
  resolveStripeCurrency,
} from "../config/stripe.js";
import {
  getBookingIntentsCollection,
  getStripeWebhookEventsCollection,
} from "../models/collections.js";
import { buildStripeWebhookEventDocument } from "../models/stripeWebhookEvent.model.js";
import { ApiError } from "../utils/ApiError.js";
import { convertToStripeMinorUnits } from "../utils/currency.js";
import { isValidObjectId, toObjectId } from "../validators/validationHelpers.js";
import { verifyConstructedStripeWebhookEvent } from "../validators/webhook.validator.js";
import { bookingFinalizationService } from "./bookingFinalization.service.js";

const SUPPORTED_CHECKOUT_SUCCESS_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

function extractPaymentIntentId(session) {
  if (!session?.payment_intent) return "";
  if (typeof session.payment_intent === "string") {
    return session.payment_intent.trim();
  }
  if (typeof session.payment_intent === "object" && session.payment_intent.id) {
    return String(session.payment_intent.id).trim();
  }
  return "";
}

/**
 * Factory implementing cryptographically verified Stripe webhook handling,
 * idempotent event deduplication, session/PaymentIntent verification,
 * and atomic booking/payment finalization.
 */
export function createStripeWebhookService({
  stripeClientGetter = getStripeClient,
  currencyResolver = () => resolveStripeCurrency(),
  webhookSecretResolver = () => process.env.STRIPE_WEBHOOK_SECRET,
  bookingIntentsCollectionGetter = getBookingIntentsCollection,
  webhookEventsCollectionGetter = getStripeWebhookEventsCollection,
  finalizationService = bookingFinalizationService,
  nowProvider = () => new Date(),
} = {}) {
  async function recordAuditWebhookEvent({
    stripeEventId,
    eventType,
    status,
    bookingIntentId = null,
    reason = "",
  }) {
    try {
      const webhookEventsCollection = await webhookEventsCollectionGetter();
      const doc = buildStripeWebhookEventDocument({
        stripeEventId,
        eventType,
        processed: true,
        processedAt: nowProvider(),
        status,
        bookingIntentId,
        reason,
      });
      await webhookEventsCollection.insertOne(doc);
    } catch (error) {
      if (error?.code === 11000) return;
      throw error;
    }
  }

  async function retrieveStripeSessionSafely(stripeClient, sessionId) {
    try {
      return await stripeClient.checkout.sessions.retrieve(sessionId);
    } catch (error) {
      const safeMsg = redactMongoUri(error?.message || "Failed to retrieve Stripe session");
      console.error(`[Webhook Error] Stripe session lookup (${sessionId}): ${safeMsg}`);
      throw new ApiError("Webhook processing temporarily failed", 500, {
        code: "STRIPE_SESSION_RETRIEVE_FAILED",
      });
    }
  }

  return {
    async processStripeWebhook({ rawBody, signatureHeader }) {
      const stripeClient = stripeClientGetter();

      // 1. Cryptographic Stripe signature verification on exact raw Buffer
      const event = verifyConstructedStripeWebhookEvent({
        rawBody,
        signatureHeader,
        stripeClient,
        webhookSecretOverride: webhookSecretResolver(),
      });

      const stripeEventId = String(event?.id || "").trim();
      const eventType = String(event?.type || "").trim();

      try {
        const webhookEventsCollection = await webhookEventsCollectionGetter();

        // 2. Fast idempotency check before external Stripe calls
        const existingEvent = await webhookEventsCollection.findOne({
          stripeEventId,
        });
        if (existingEvent?.processed === true) {
          console.info(
            `[Webhook] event=${stripeEventId} type=${eventType} result=already_processed`
          );
          return {
            alreadyProcessed: true,
            message: "Webhook event already processed",
          };
        }

        // 3. Safely ignore unsupported event types without modifying domain records
        if (
          !SUPPORTED_CHECKOUT_SUCCESS_EVENTS.has(eventType) &&
          eventType !== "checkout.session.async_payment_failed" &&
          eventType !== "checkout.session.expired"
        ) {
          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            status: "ignored_unsupported_event",
          });
          console.info(
            `[Webhook] event=${stripeEventId} type=${eventType} result=ignored`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        const rawSessionId = String(event?.data?.object?.id || "").trim();
        if (!rawSessionId) {
          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            status: "rejected_missing_session_id",
            reason: "Missing Checkout Session ID in webhook event",
          });
          console.error(
            `[Webhook Alert] event=${stripeEventId} type=${eventType} missing session ID`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        // 4. Re-retrieve authoritative Checkout Session directly from Stripe
        const session = await retrieveStripeSessionSafely(stripeClient, rawSessionId);
        if (!session || session.id !== rawSessionId || session.mode !== "payment") {
          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            status: "rejected_invalid_session",
            reason: "Retrieved Stripe Checkout Session invalid or non-payment mode",
          });
          console.error(
            `[Webhook Alert] event=${stripeEventId} session=${rawSessionId} invalid mode or missing`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        const bookingIntentIdStr = String(session.metadata?.bookingIntentId || "").trim();
        const clientReferenceIdStr = String(session.client_reference_id || "").trim();
        if (
          !isValidObjectId(bookingIntentIdStr) ||
          bookingIntentIdStr !== clientReferenceIdStr
        ) {
          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            status: "rejected_invalid_metadata",
            reason: "Invalid or mismatched bookingIntentId metadata/client_reference_id",
          });
          console.error(
            `[Webhook Alert] event=${stripeEventId} session=${session.id} mismatched metadata/client_reference_id`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        const bookingIntentObjectId = toObjectId(bookingIntentIdStr, "bookingIntentId");
        const bookingIntentsCollection = await bookingIntentsCollectionGetter();
        const intent = await bookingIntentsCollection.findOne({
          _id: bookingIntentObjectId,
        });

        if (!intent) {
          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            bookingIntentId: bookingIntentObjectId,
            status: "rejected_unknown_intent",
            reason: "Booking reservation not found for webhook session",
          });
          console.error(
            `[Webhook Alert] event=${stripeEventId} bookingIntentId=${bookingIntentIdStr} unknown reservation`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        // Verify consistent reservation/session linkage
        if (String(intent.stripeCheckoutSessionId || "") !== String(session.id)) {
          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            bookingIntentId: intent._id,
            status: "rejected_session_mismatch",
            reason: "Stripe Checkout Session ID does not match stored bookingIntent",
          });
          console.error(
            `[Webhook Alert] event=${stripeEventId} intent=${bookingIntentIdStr} session mismatch`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        if (
          (session.metadata?.customerId &&
            String(intent.customerId) !== String(session.metadata.customerId)) ||
          (session.metadata?.ownerId &&
            String(intent.ownerId) !== String(session.metadata.ownerId)) ||
          (session.metadata?.equipmentId &&
            String(intent.equipmentId) !== String(session.metadata.equipmentId))
        ) {
          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            bookingIntentId: intent._id,
            status: "rejected_entity_mismatch",
            reason: "Checkout metadata entity IDs do not match booking intent",
          });
          console.error(
            `[Webhook Alert] event=${stripeEventId} intent=${bookingIntentIdStr} customer/owner/equipment mismatch`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        // 5. Handle async failure event cleanly without cancelling already converted bookings
        if (eventType === "checkout.session.async_payment_failed") {
          const now = nowProvider();
          if (intent.status === BOOKING_INTENT_STATUSES.CONVERTED) {
            await recordAuditWebhookEvent({
              stripeEventId,
              eventType,
              bookingIntentId: intent._id,
              status: "ignored_already_converted",
            });
            return {
              alreadyProcessed: false,
              message: "Webhook processed successfully",
            };
          }

          await bookingIntentsCollection.updateOne(
            {
              _id: intent._id,
              status: { $ne: BOOKING_INTENT_STATUSES.CONVERTED },
            },
            {
              $set: {
                status: BOOKING_INTENT_STATUSES.FAILED,
                paymentStatus: PAYMENT_STATUSES.FAILED,
                failedAt: now,
                updatedAt: now,
              },
              $unset: {
                expiresAt: "",
                checkoutInProgressUntil: "",
              },
            }
          );

          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            bookingIntentId: intent._id,
            status: "processed_payment_failed",
          });
          console.info(
            `[Webhook] event=${stripeEventId} type=${eventType} bookingIntentId=${bookingIntentIdStr} result=failed_released`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        // 6. Handle checkout expiration event cleanly without touching converted bookings
        if (eventType === "checkout.session.expired") {
          const now = nowProvider();
          if (intent.status === BOOKING_INTENT_STATUSES.CONVERTED) {
            await recordAuditWebhookEvent({
              stripeEventId,
              eventType,
              bookingIntentId: intent._id,
              status: "ignored_already_converted",
            });
            return {
              alreadyProcessed: false,
              message: "Webhook processed successfully",
            };
          }

          await bookingIntentsCollection.updateOne(
            {
              _id: intent._id,
              status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
            },
            {
              $set: {
                status: BOOKING_INTENT_STATUSES.EXPIRED,
                updatedAt: now,
              },
              $unset: {
                checkoutInProgressUntil: "",
              },
            }
          );

          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            bookingIntentId: intent._id,
            status: "processed_expired",
          });
          console.info(
            `[Webhook] event=${stripeEventId} type=${eventType} bookingIntentId=${bookingIntentIdStr} result=expired`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        // 7. Success event handling (`checkout.session.completed` or `checkout.session.async_payment_succeeded`)
        if (
          eventType === "checkout.session.completed" &&
          session.status === "complete" &&
          session.payment_status !== "paid"
        ) {
          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            bookingIntentId: intent._id,
            status: "deferred_awaiting_async_payment",
          });
          console.info(
            `[Webhook] event=${stripeEventId} type=${eventType} bookingIntentId=${bookingIntentIdStr} result=unpaid_deferred`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        if (session.status !== "complete" || session.payment_status !== "paid") {
          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            bookingIntentId: intent._id,
            status: "rejected_incomplete_or_unpaid_session",
            reason: `Session status=${session.status}, payment_status=${session.payment_status}`,
          });
          console.error(
            `[Webhook Alert] event=${stripeEventId} intent=${bookingIntentIdStr} incomplete/unpaid status`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        // Verify currency and minor-unit amount strictly against reservation & config
        const configuredCurrency = currencyResolver();
        const sessionCurrency = String(session.currency || "").trim().toLowerCase();
        const intentCurrency = String(intent.currency || configuredCurrency)
          .trim()
          .toLowerCase();
        const expectedMinorUnits = convertToStripeMinorUnits(
          Number(intent.totalAmount),
          configuredCurrency
        );

        if (
          sessionCurrency !== configuredCurrency ||
          intentCurrency !== configuredCurrency ||
          Number(session.amount_total) !== expectedMinorUnits
        ) {
          await recordAuditWebhookEvent({
            stripeEventId,
            eventType,
            bookingIntentId: intent._id,
            status: "rejected_amount_or_currency_mismatch",
            reason: "Stripe session currency or amount_total does not match reservation",
          });
          console.error(
            `[Webhook Alert] event=${stripeEventId} intent=${bookingIntentIdStr} amount/currency mismatch`
          );
          return {
            alreadyProcessed: false,
            message: "Webhook processed successfully",
          };
        }

        // Retrieve & verify PaymentIntent when present
        const paymentIntentId = extractPaymentIntentId(session);
        let paidAt = nowProvider();
        if (paymentIntentId) {
          let paymentIntent;
          try {
            paymentIntent = await stripeClient.paymentIntents.retrieve(
              paymentIntentId
            );
          } catch (error) {
            const safeMsg = redactMongoUri(
              error?.message || "Failed to retrieve PaymentIntent"
            );
            console.error(
              `[Webhook Error] PaymentIntent lookup (${paymentIntentId}): ${safeMsg}`
            );
            throw new ApiError("Webhook processing temporarily failed", 500, {
              code: "STRIPE_PAYMENT_INTENT_RETRIEVE_FAILED",
            });
          }

          const piCurrency = String(paymentIntent?.currency || "")
            .trim()
            .toLowerCase();
          const piReceived = Number(
            paymentIntent?.amount_received ?? paymentIntent?.amount
          );

          if (
            !paymentIntent ||
            paymentIntent.id !== paymentIntentId ||
            paymentIntent.status !== "succeeded" ||
            piCurrency !== configuredCurrency ||
            piReceived !== expectedMinorUnits
          ) {
            await recordAuditWebhookEvent({
              stripeEventId,
              eventType,
              bookingIntentId: intent._id,
              status: "rejected_payment_intent_verification_failed",
              reason: "PaymentIntent status, currency, or amount_received invalid",
            });
            console.error(
              `[Webhook Alert] event=${stripeEventId} pi=${paymentIntentId} verification failed`
            );
            return {
              alreadyProcessed: false,
              message: "Webhook processed successfully",
            };
          }

          if (typeof paymentIntent.created === "number") {
            paidAt = new Date(paymentIntent.created * 1000);
          }
        }

        // 8. Execute atomic final booking + payment creation & intent conversion inside MongoDB tx
        const outcome = await finalizationService.finalizePaidCheckoutSession({
          eventId: stripeEventId,
          eventType,
          bookingIntentId: intent._id,
          stripeSessionId: session.id,
          stripePaymentIntentId: paymentIntentId,
          amountMinor: expectedMinorUnits,
          currency: configuredCurrency,
          paidAt,
        });

        console.info(
          `[Webhook] event=${stripeEventId} type=${eventType} bookingIntentId=${bookingIntentIdStr} finalBookingId=${outcome.bookingId || "n/a"} result=${outcome.status}`
        );

        return {
          alreadyProcessed: Boolean(outcome.alreadyProcessed),
          message: outcome.alreadyProcessed
            ? "Webhook event already processed"
            : "Webhook processed successfully",
        };
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        const safeMsg = redactMongoUri(
          error?.message || "Transient webhook processing error"
        );
        console.error(
          `[Webhook Error] event=${stripeEventId} type=${eventType}: ${safeMsg}`
        );
        throw new ApiError("Webhook processing temporarily failed", 500, {
          code: "WEBHOOK_TEMPORARILY_FAILED",
          isOperational: true,
        });
      }
    },
  };
}

export const stripeWebhookService = createStripeWebhookService();
