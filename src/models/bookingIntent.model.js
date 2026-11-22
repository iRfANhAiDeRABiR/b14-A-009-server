import { BOOKING_STATUSES, DEFAULT_BOOKING_INTENT_STATUS } from "../constants/booking.js";
import { DEFAULT_CURRENCY, PAYMENT_STATUSES } from "../constants/payment.js";
import { calculateInclusiveDays, formatUTCDateOnly } from "../utils/rentalDate.js";
import { normalizeUserIdentifier, toObjectId } from "../validators/validationHelpers.js";
import { getBookingIntentsCollection } from "./collections.js";

/**
 * @typedef {Object} BookingIntentDocument
 * @property {import("mongodb").ObjectId} [_id]
 * @property {string} customerId
 * @property {string} ownerId
 * @property {import("mongodb").ObjectId} equipmentId
 * @property {Date} startDate
 * @property {Date} endDate
 * @property {number} quantity
 * @property {string} contactNumber
 * @property {string} deliveryAddress
 * @property {string} additionalNotes
 * @property {"Daily"|"Weekly"|"Monthly"} rentalType
 * @property {number} rentalPrice
 * @property {number} billableUnits
 * @property {number} totalAmount
 * @property {string} currency
 * @property {"PendingPayment"|"Expired"|"Converted"|"Failed"} status
 * @property {Date} expiresAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export { getBookingIntentsCollection };

/**
 * Builds a validated temporary reservation intent awaiting payment verification.
 */
export function buildBookingIntentDocument({
  customerId,
  ownerId,
  equipmentId,
  startDate,
  endDate,
  quantity,
  contactNumber,
  deliveryAddress,
  additionalNotes = "",
  rentalType,
  rentalPrice,
  billableUnits,
  totalAmount,
  currency = DEFAULT_CURRENCY,
  expiresAt,
  now = new Date(),
}) {
  return {
    customerId: normalizeUserIdentifier(customerId, "customerId"),
    ownerId: normalizeUserIdentifier(ownerId, "ownerId"),
    equipmentId: toObjectId(equipmentId, "equipmentId"),
    startDate,
    endDate,
    quantity,
    contactNumber,
    deliveryAddress,
    additionalNotes,
    rentalType,
    rentalPrice,
    billableUnits,
    totalAmount,
    currency,
    status: DEFAULT_BOOKING_INTENT_STATUS,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Shapes a temporary booking reservation for customer checkout handoff without exposing
 * internal owner metadata or payment credentials.
 */
export function sanitizeBookingIntentResponse(doc, equipmentName = "") {
  if (!doc || typeof doc !== "object") return null;

  return {
    bookingIntentId: doc._id ? String(doc._id) : "",
    equipmentId: doc.equipmentId ? String(doc.equipmentId) : "",
    equipmentName: equipmentName || "",
    startDate:
      doc.startDate instanceof Date
        ? formatUTCDateOnly(doc.startDate)
        : String(doc.startDate || ""),
    endDate:
      doc.endDate instanceof Date
        ? formatUTCDateOnly(doc.endDate)
        : String(doc.endDate || ""),
    quantity: Number(doc.quantity) || 0,
    rentalType: doc.rentalType || "",
    rentalPrice: Number(doc.rentalPrice) || 0,
    billableUnits: Number(doc.billableUnits) || 0,
    totalAmount: Number(doc.totalAmount) || 0,
    currency: doc.currency || DEFAULT_CURRENCY,
    status: doc.status || DEFAULT_BOOKING_INTENT_STATUS,
    expiresAt:
      doc.expiresAt instanceof Date
        ? doc.expiresAt.toISOString()
        : doc.expiresAt || null,
  };
}

/**
 * Formats a finalized Customer booking record safely for My Rentals list & Booking Details views.
 * Never exposes owner/customer cross-party PII or Stripe secret metadata.
 */
export function formatCustomerBookingRecord(doc, { detailed = false } = {}) {
  if (!doc || typeof doc !== "object") return null;

  const eq =
    doc.equipmentDoc && typeof doc.equipmentDoc === "object" ? doc.equipmentDoc : {};
  const pay =
    doc.paymentDoc && typeof doc.paymentDoc === "object" ? doc.paymentDoc : {};

  const startDateObj =
    doc.startDate instanceof Date ? doc.startDate : new Date(doc.startDate);
  const endDateObj =
    doc.endDate instanceof Date ? doc.endDate : new Date(doc.endDate);
  const durationDays = calculateInclusiveDays(startDateObj, endDateObj);

  const equipmentId = eq._id
    ? String(eq._id)
    : doc.equipmentId
      ? String(doc.equipmentId)
      : "";
  const equipmentName = eq.name || "Equipment Item";
  const equipmentImage = eq.image || "";
  const category = eq.category || "";

  const record = {
    _id: doc._id ? String(doc._id) : "",
    bookingReference: doc._id ? String(doc._id) : "",
    equipmentId,
    equipmentName,
    equipmentImage,
    category,
    equipment: {
      _id: equipmentId,
      name: equipmentName,
      image: equipmentImage,
      category,
    },
    startDate: formatUTCDateOnly(startDateObj),
    endDate: formatUTCDateOnly(endDateObj),
    durationDays,
    createdAt: doc.createdAt || null,
    quantity: Number(doc.quantity) || 0,
    rentalType: doc.rentalType || eq.rentalType || "",
    rentalPrice: Number(doc.rentalPrice) || 0,
    totalAmount: Number(doc.totalAmount) || 0,
    currency: doc.currency || DEFAULT_CURRENCY,
    paymentStatus: doc.paymentStatus || PAYMENT_STATUSES.PENDING,
    bookingStatus: doc.bookingStatus || BOOKING_STATUSES.PENDING,
  };

  if (detailed) {
    record.transactionId =
      pay.stripePaymentIntentId || pay.transactionId || doc.transactionId || "";
    record.paidAt = pay.paidAt || doc.paidAt || null;
    record.contactNumber = doc.contactNumber || "";
    record.deliveryAddress = doc.deliveryAddress || "";
    record.additionalNotes = doc.additionalNotes || "";
  }

  return record;
}
