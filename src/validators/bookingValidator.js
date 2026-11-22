import {
  ALLOWED_BOOKING_STATUSES,
  CONTACT_INQUIRY_TYPES,
  DEFAULT_BOOKING_STATUS,
  DEFAULT_CONTACT_MESSAGE_STATUS,
} from "../constants/booking.js";
import { RENTAL_TYPES } from "../constants/equipment.js";
import {
  ALLOWED_PAYMENT_STATUSES,
  DEFAULT_CURRENCY,
  DEFAULT_PAYMENT_STATUS,
  PAYMENT_PROVIDERS,
  roundCurrency,
} from "../constants/payment.js";
import { ApiError } from "../utils/ApiError.js";
import {
  cleanString,
  isValidObjectId,
  isValidUserIdentifier,
  normalizeUserIdentifier,
  toObjectId,
  validateEmailAddress,
} from "./validationHelpers.js";

function parseValidDate(rawValue, label, errors) {
  const date = rawValue instanceof Date ? rawValue : new Date(rawValue);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    errors.push(`Valid ${label} date is required.`);
    return null;
  }
  return date;
}

/**
 * Validates booking document inputs, ensuring proper Date values, positive integer quantity,
 * server-calculated monetary values, and consistent status defaults.
 */
export function validateBookingInput(payload = {}) {
  const errors = [];

  if (!isValidUserIdentifier(payload.customerId)) {
    errors.push("Valid customerId is required.");
  }
  if (!isValidUserIdentifier(payload.ownerId)) {
    errors.push("Valid ownerId is required.");
  }
  if (!isValidObjectId(payload.equipmentId)) {
    errors.push("Valid equipmentId is required.");
  }

  const startDate = parseValidDate(payload.startDate, "start", errors);
  const endDate = parseValidDate(payload.endDate, "end", errors);
  if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
    errors.push("Start date cannot be after end date.");
  }

  const quantity = Number(payload.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    errors.push("Quantity must be a positive integer.");
  }

  const contactNumber = cleanString(payload.contactNumber);
  if (!contactNumber || contactNumber.length < 6 || contactNumber.length > 30) {
    errors.push("Valid contact number is required.");
  }

  const deliveryAddress = cleanString(payload.deliveryAddress);
  if (!deliveryAddress || deliveryAddress.length < 5 || deliveryAddress.length > 300) {
    errors.push("Valid delivery address is required.");
  }

  const additionalNotes = cleanString(payload.additionalNotes);
  if (additionalNotes.length > 500) {
    errors.push("Additional notes cannot exceed 500 characters.");
  }

  const rentalType = cleanString(payload.rentalType);
  if (!RENTAL_TYPES.includes(rentalType)) {
    errors.push(`Rental type must be one of: ${RENTAL_TYPES.join(", ")}.`);
  }

  const rentalPrice = Number(payload.rentalPrice);
  if (!Number.isFinite(rentalPrice) || rentalPrice <= 0) {
    errors.push("Rental price must be a positive number.");
  }

  const totalAmount = Number(payload.totalAmount);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    errors.push("Total amount must be a positive number.");
  }

  const currency = cleanString(payload.currency || DEFAULT_CURRENCY).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    errors.push("Currency must be a valid 3-letter ISO code.");
  }

  if (errors.length > 0) {
    throw new ApiError(errors[0], 400, {
      code: "VALIDATION_ERROR",
      details: errors,
    });
  }

  return {
    customerId: normalizeUserIdentifier(payload.customerId, "customerId"),
    ownerId: normalizeUserIdentifier(payload.ownerId, "ownerId"),
    equipmentId: toObjectId(payload.equipmentId, "equipmentId"),
    startDate,
    endDate,
    quantity,
    contactNumber,
    deliveryAddress,
    additionalNotes,
    rentalType,
    rentalPrice: roundCurrency(rentalPrice),
    totalAmount: roundCurrency(totalAmount),
    currency,
    paymentStatus: DEFAULT_PAYMENT_STATUS,
    bookingStatus: DEFAULT_BOOKING_STATUS,
  };
}

/**
 * Validates payment record inputs without ever accepting or persisting card details.
 */
export function validatePaymentInput(payload = {}) {
  const errors = [];

  if (!isValidObjectId(payload.bookingId)) {
    errors.push("Valid bookingId is required.");
  }
  if (!isValidUserIdentifier(payload.customerId)) {
    errors.push("Valid customerId is required.");
  }
  if (!isValidUserIdentifier(payload.ownerId)) {
    errors.push("Valid ownerId is required.");
  }
  if (!isValidObjectId(payload.equipmentId)) {
    errors.push("Valid equipmentId is required.");
  }

  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    errors.push("Payment amount must be a positive number.");
  }

  const currency = cleanString(payload.currency || DEFAULT_CURRENCY).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    errors.push("Currency must be a valid 3-letter ISO code.");
  }

  const status = cleanString(payload.status || DEFAULT_PAYMENT_STATUS);
  if (!ALLOWED_PAYMENT_STATUSES.includes(status)) {
    errors.push(
      `Payment status must be one of: ${ALLOWED_PAYMENT_STATUSES.join(", ")}.`
    );
  }

  if (errors.length > 0) {
    throw new ApiError(errors[0], 400, {
      code: "VALIDATION_ERROR",
      details: errors,
    });
  }

  const stripeCheckoutSessionId = cleanString(payload.stripeCheckoutSessionId);
  const stripePaymentIntentId = cleanString(payload.stripePaymentIntentId);

  return {
    bookingId: toObjectId(payload.bookingId, "bookingId"),
    customerId: normalizeUserIdentifier(payload.customerId, "customerId"),
    ownerId: normalizeUserIdentifier(payload.ownerId, "ownerId"),
    equipmentId: toObjectId(payload.equipmentId, "equipmentId"),
    provider: cleanString(payload.provider || PAYMENT_PROVIDERS.STRIPE).toLowerCase(),
    ...(stripeCheckoutSessionId ? { stripeCheckoutSessionId } : {}),
    ...(stripePaymentIntentId ? { stripePaymentIntentId } : {}),
    amount: roundCurrency(amount),
    currency,
    status,
    paidAt: payload.paidAt instanceof Date ? payload.paidAt : null,
  };
}

/**
 * Validates contact inquiry payloads prior to storage.
 */
export function validateContactMessageInput(payload = {}) {
  const errors = [];

  const name = cleanString(payload.name);
  if (!name || name.length < 2 || name.length > 100) {
    errors.push("Name must be between 2 and 100 characters.");
  }

  const email = validateEmailAddress(payload.email);
  if (!email) {
    errors.push("Valid email address is required.");
  }

  const inquiryType = cleanString(payload.inquiryType);
  if (!CONTACT_INQUIRY_TYPES.includes(inquiryType)) {
    errors.push(
      `Inquiry type must be one of: ${CONTACT_INQUIRY_TYPES.join(", ")}.`
    );
  }

  const subject = cleanString(payload.subject);
  if (!subject || subject.length < 3 || subject.length > 150) {
    errors.push("Subject must be between 3 and 150 characters.");
  }

  const message = cleanString(payload.message);
  if (!message || message.length < 10 || message.length > 2500) {
    errors.push("Message must be between 10 and 2500 characters.");
  }

  if (errors.length > 0) {
    throw new ApiError(errors[0], 400, {
      code: "VALIDATION_ERROR",
      details: errors,
    });
  }

  return {
    name,
    email,
    inquiryType,
    subject,
    message,
    status: DEFAULT_CONTACT_MESSAGE_STATUS,
  };
}

export function validateBookingStatus(status) {
  const clean = cleanString(status);
  if (!ALLOWED_BOOKING_STATUSES.includes(clean)) {
    throw new ApiError(
      `Invalid booking status. Allowed statuses: ${ALLOWED_BOOKING_STATUSES.join(", ")}.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }
  return clean;
}
