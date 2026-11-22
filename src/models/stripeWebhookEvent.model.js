import { ApiError } from "../utils/ApiError.js";
import { getStripeWebhookEventsCollection } from "./collections.js";
import { cleanString } from "../validators/validationHelpers.js";

/**
 * @typedef {Object} StripeWebhookEventDocument
 * @property {import("mongodb").ObjectId} [_id]
 * @property {string} stripeEventId - Globally unique Stripe webhook event identifier (e.g., evt_...)
 * @property {string} eventType
 * @property {boolean} processed
 * @property {Date|null} processedAt
 * @property {Date} createdAt
 */

export { getStripeWebhookEventsCollection };

/**
 * Builds an idempotent Stripe webhook event tracking record.
 */
export function buildStripeWebhookEventDocument(payload = {}) {
  const stripeEventId = cleanString(payload.stripeEventId);
  const eventType = cleanString(payload.eventType);

  if (!stripeEventId) {
    throw new ApiError("Valid stripeEventId is required.", 400, {
      code: "VALIDATION_ERROR",
    });
  }
  if (!eventType) {
    throw new ApiError("Valid eventType is required.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const processed = Boolean(payload.processed);
  return {
    stripeEventId,
    eventType,
    processed,
    status: cleanString(payload.status) || (processed ? "processed" : "processing"),
    ...(payload.bookingIntentId ? { bookingIntentId: payload.bookingIntentId } : {}),
    ...(payload.finalBookingId ? { finalBookingId: payload.finalBookingId } : {}),
    ...(payload.paymentId ? { paymentId: payload.paymentId } : {}),
    ...(payload.reason ? { reason: cleanString(payload.reason) } : {}),
    processedAt: processed ? payload.processedAt || new Date() : null,
    createdAt: new Date(),
  };
}
