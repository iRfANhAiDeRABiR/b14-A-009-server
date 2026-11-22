import { getBookingsCollection } from "./collections.js";
import { validateBookingInput } from "../validators/bookingValidator.js";

/**
 * @typedef {Object} BookingDocument
 * @property {import("mongodb").ObjectId} [_id]
 * @property {import("mongodb").ObjectId | string} customerId
 * @property {import("mongodb").ObjectId | string} ownerId
 * @property {import("mongodb").ObjectId} equipmentId
 * @property {Date} startDate
 * @property {Date} endDate
 * @property {number} quantity
 * @property {string} contactNumber
 * @property {string} deliveryAddress
 * @property {string} additionalNotes
 * @property {"Daily"|"Weekly"|"Monthly"} rentalType
 * @property {number} rentalPrice - Unit rate stored at booking creation time
 * @property {number} totalAmount - Server-verified major currency total rounded cleanly to 2 decimals
 * @property {string} currency
 * @property {"Pending"|"Paid"|"Failed"|"Refunded"} paymentStatus
 * @property {"Pending"|"Confirmed"|"Active"|"Completed"|"Cancelled"} bookingStatus
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export { getBookingsCollection };

/**
 * Validates and constructs a booking record with `Date` fields and default `Pending` statuses.
 */
export function buildBookingDocument(payload = {}) {
  const clean = validateBookingInput(payload);
  const now = new Date();
  return {
    ...clean,
    createdAt: now,
    updatedAt: now,
  };
}
