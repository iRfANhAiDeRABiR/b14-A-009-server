import { getPaymentsCollection } from "./collections.js";
import { validatePaymentInput } from "../validators/bookingValidator.js";

/**
 * @typedef {Object} PaymentDocument
 * @property {import("mongodb").ObjectId} [_id]
 * @property {import("mongodb").ObjectId} bookingId
 * @property {import("mongodb").ObjectId | string} customerId
 * @property {import("mongodb").ObjectId | string} ownerId
 * @property {import("mongodb").ObjectId} equipmentId
 * @property {string} provider
 * @property {string} [stripeCheckoutSessionId]
 * @property {string} [stripePaymentIntentId]
 * @property {number} amount - Major currency amount rounded to 2 decimals; use toMinorUnits() for Stripe minor units
 * @property {string} currency
 * @property {"Pending"|"Paid"|"Failed"|"Refunded"} status
 * @property {Date|null} paidAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export { getPaymentsCollection };

/**
 * Builds a validated payment record without card details.
 * Optional Stripe identifiers are only stored when non-empty strings are present.
 */
export function buildPaymentDocument(payload = {}) {
  const clean = validatePaymentInput(payload);
  const now = new Date();
  return {
    ...clean,
    createdAt: now,
    updatedAt: now,
  };
}
