import { ALLOWED_BOOKING_STATUSES } from "../constants/booking.js";
import { ALLOWED_PAYMENT_STATUSES } from "../constants/payment.js";
import { ApiError } from "../utils/ApiError.js";
import { validateRentalDateRange } from "../utils/rentalDate.js";
import { cleanString, isValidObjectId, toObjectId } from "./validationHelpers.js";

const DEFAULT_BOOKINGS_PAGE = 1;
const DEFAULT_BOOKINGS_LIMIT = 10;
const MAX_BOOKINGS_LIMIT = 50;
const MAX_BOOKING_SEARCH_LENGTH = 100;

const RESTRICTED_BOOKING_FIELDS = Object.freeze([
  "customerId",
  "ownerId",
  "rentalPrice",
  "totalAmount",
  "billableUnits",
  "currency",
  "paymentStatus",
  "bookingStatus",
  "status",
  "expiresAt",
]);

function assertObjectBody(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Invalid request body", 400, {
      code: "VALIDATION_ERROR",
    });
  }
}

export function validateBookingEquipmentId(rawEquipmentId) {
  if (typeof rawEquipmentId !== "string" || !isValidObjectId(cleanString(rawEquipmentId))) {
    throw new ApiError("Invalid equipment ID", 400, {
      code: "INVALID_EQUIPMENT_ID",
    });
  }
  return toObjectId(rawEquipmentId, "equipmentId");
}

export function validateBookingIdParam(rawBookingId) {
  if (typeof rawBookingId !== "string" || !isValidObjectId(cleanString(rawBookingId))) {
    throw new ApiError("Invalid booking ID", 400, {
      code: "INVALID_BOOKING_ID",
    });
  }
  return toObjectId(rawBookingId, "bookingId");
}

/**
 * Validates booking quantity strictly as a positive integer >= 1.
 * Rejects floats, booleans, empty strings, non-numeric strings, zero, negatives, NaN, and Infinity.
 */
export function validateRentalQuantity(rawQuantity) {
  if (
    rawQuantity === undefined ||
    rawQuantity === null ||
    typeof rawQuantity === "boolean" ||
    Array.isArray(rawQuantity) ||
    typeof rawQuantity === "object"
  ) {
    throw new ApiError("Invalid rental quantity", 400, {
      code: "INVALID_QUANTITY",
    });
  }

  if (typeof rawQuantity === "string") {
    const trimmed = rawQuantity.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new ApiError("Invalid rental quantity", 400, {
        code: "INVALID_QUANTITY",
      });
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new ApiError("Invalid rental quantity", 400, {
        code: "INVALID_QUANTITY",
      });
    }
    return parsed;
  }

  if (typeof rawQuantity !== "number" || !Number.isSafeInteger(rawQuantity) || rawQuantity < 1) {
    throw new ApiError("Invalid rental quantity", 400, {
      code: "INVALID_QUANTITY",
    });
  }

  return rawQuantity;
}

/**
 * Validates POST /api/bookings/check-availability payloads.
 */
export function validateAvailabilityCheckPayload(payload, { now = new Date() } = {}) {
  assertObjectBody(payload);

  const equipmentId = validateBookingEquipmentId(payload.equipmentId);
  const dateRange = validateRentalDateRange(payload.startDate, payload.endDate, { now });
  const quantity = validateRentalQuantity(payload.quantity);

  return {
    equipmentId,
    ...dateRange,
    quantity,
  };
}

/**
 * Validates POST /api/bookings reservation payloads while explicitly rejecting
 * client-supplied financial, ownership, status, or expiration fields.
 */
export function validateCreateBookingPayload(payload, { now = new Date() } = {}) {
  assertObjectBody(payload);

  const tamperedFields = RESTRICTED_BOOKING_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(payload, field)
  );
  if (tamperedFields.length > 0) {
    throw new ApiError(
      `Restricted or server-calculated field(s) cannot be provided by client: ${tamperedFields.join(", ")}.`,
      400,
      { code: "RESTRICTED_BOOKING_FIELD" }
    );
  }

  const base = validateAvailabilityCheckPayload(payload, { now });

  const contactNumber = cleanString(payload.contactNumber);
  if (
    typeof payload.contactNumber !== "string" ||
    contactNumber.length < 6 ||
    contactNumber.length > 30
  ) {
    throw new ApiError("Valid contact number (6-30 characters) is required.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const deliveryAddress = cleanString(payload.deliveryAddress);
  if (
    typeof payload.deliveryAddress !== "string" ||
    deliveryAddress.length < 5 ||
    deliveryAddress.length > 300
  ) {
    throw new ApiError("Valid delivery address (5-300 characters) is required.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  let additionalNotes = "";
  if (payload.additionalNotes !== undefined && payload.additionalNotes !== null) {
    if (typeof payload.additionalNotes !== "string") {
      throw new ApiError("Additional notes must be text.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    additionalNotes = payload.additionalNotes.trim();
    if (additionalNotes.length > 500) {
      throw new ApiError("Additional notes cannot exceed 500 characters.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
  }

  return {
    ...base,
    contactNumber,
    deliveryAddress,
    additionalNotes,
  };
}

/**
 * Validates GET /api/bookings/my query parameters strictly without permitting customerId spoofing.
 */
export function validateCustomerBookingsQuery(rawQuery = {}) {
  const parsePosInt = (rawVal, fallback, max) => {
    if (rawVal === undefined || rawVal === null || String(rawVal).trim() === "") {
      return fallback;
    }
    if (typeof rawVal !== "string" && typeof rawVal !== "number") {
      throw new ApiError("Invalid pagination parameters", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    const parsed = Number(String(rawVal).trim());
    if (!Number.isInteger(parsed) || parsed < 1 || (max && parsed > max)) {
      throw new ApiError("Invalid pagination parameters", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    return parsed;
  };

  const page = parsePosInt(rawQuery.page, DEFAULT_BOOKINGS_PAGE);
  const limit = parsePosInt(rawQuery.limit, DEFAULT_BOOKINGS_LIMIT, MAX_BOOKINGS_LIMIT);

  let bookingStatus = "all";
  const rawBookingStatus = cleanString(rawQuery.bookingStatus || rawQuery.status);
  if (rawBookingStatus && rawBookingStatus.toLowerCase() !== "all") {
    if (!ALLOWED_BOOKING_STATUSES.includes(rawBookingStatus)) {
      throw new ApiError("Invalid booking status filter", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    bookingStatus = rawBookingStatus;
  }

  let paymentStatus = "all";
  const rawPaymentStatus = cleanString(rawQuery.paymentStatus);
  if (rawPaymentStatus && rawPaymentStatus.toLowerCase() !== "all") {
    if (!ALLOWED_PAYMENT_STATUSES.includes(rawPaymentStatus)) {
      throw new ApiError("Invalid payment status filter", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    paymentStatus = rawPaymentStatus;
  }

  const search = cleanString(rawQuery.search);
  if (search.length > MAX_BOOKING_SEARCH_LENGTH) {
    throw new ApiError("Search query cannot exceed 100 characters.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  return {
    page,
    limit,
    skip: (page - 1) * limit,
    bookingStatus,
    paymentStatus,
    search,
  };
}
