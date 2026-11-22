import { ALLOWED_BOOKING_STATUSES } from "../constants/booking.js";
import { ALLOWED_PAYMENT_STATUSES } from "../constants/payment.js";
import { ApiError } from "../utils/ApiError.js";
import {
  cleanString,
  isValidObjectId,
  isValidUserIdentifier,
  toObjectId,
} from "./validationHelpers.js";

export const DEFAULT_RENTALS_PAGE = 1;
export const DEFAULT_RENTALS_LIMIT = 10;
export const MAX_RENTALS_LIMIT = 50;
export const MAX_RENTAL_SEARCH_LENGTH = 100;

export const ALLOWED_RENTAL_SORTS = Object.freeze([
  "newest",
  "oldest",
  "amount_asc",
  "amount_desc",
  "start_date",
  "end_date",
]);

export const RENTAL_SORT_MAP = Object.freeze({
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  amount_asc: { totalAmount: 1, _id: -1 },
  amount_desc: { totalAmount: -1, _id: -1 },
  start_date: { startDate: 1, _id: -1 },
  end_date: { endDate: 1, _id: -1 },
});

function assertNoOperatorQueryKeys(rawQuery) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    return;
  }

  for (const [key, value] of Object.entries(rawQuery)) {
    if (key.startsWith("$") || /\[\s*\$/.test(key)) {
      throw new ApiError("Invalid rental query parameters", 400, {
        code: "INVALID_QUERY_PARAMS",
      });
    }
    if (value !== null && typeof value === "object") {
      throw new ApiError("Invalid rental query parameters", 400, {
        code: "INVALID_QUERY_PARAMS",
      });
    }
  }
}

function readOptionalQueryString(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return "";
  }
  if (typeof rawValue !== "string" && typeof rawValue !== "number") {
    throw new ApiError("Invalid rental query parameters", 400, {
      code: "INVALID_QUERY_PARAMS",
    });
  }
  return String(rawValue).trim();
}

function parsePositiveIntParam(rawValue, fallback, max) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallback;
  }
  if (typeof rawValue !== "string" && typeof rawValue !== "number") {
    throw new ApiError("Invalid rental query parameters", 400, {
      code: "INVALID_QUERY_PARAMS",
    });
  }
  const parsed = Number(String(rawValue).trim());
  if (!Number.isInteger(parsed) || parsed < 1 || (max && parsed > max)) {
    throw new ApiError("Invalid rental query parameters", 400, {
      code: "INVALID_QUERY_PARAMS",
    });
  }
  return parsed;
}

/**
 * Validates MongoDB ObjectId route parameters on rental details endpoints.
 */
export function validateRentalObjectIdParam(
  rawId,
  message = "Invalid rental record ID"
) {
  if (typeof rawId !== "string" || !isValidObjectId(cleanString(rawId))) {
    throw new ApiError(message, 400, {
      code: "INVALID_OBJECT_ID",
    });
  }
  return toObjectId(cleanString(rawId), "id");
}

/**
 * Validates search, filter, sort, pagination, and permitted relational IDs
 * across Customer, Owner, and Admin rental endpoints.
 */
export function validateRentalListQuery(
  rawQuery = {},
  {
    allowEquipmentFilter = false,
    allowCustomerFilter = false,
    allowOwnerFilter = false,
  } = {}
) {
  assertNoOperatorQueryKeys(rawQuery);

  const search = readOptionalQueryString(rawQuery.search);
  if (search.length > MAX_RENTAL_SEARCH_LENGTH) {
    throw new ApiError("Invalid rental query parameters", 400, {
      code: "INVALID_QUERY_PARAMS",
    });
  }

  let bookingStatus = "all";
  const rawBookingStatus = readOptionalQueryString(
    rawQuery.bookingStatus !== undefined ? rawQuery.bookingStatus : rawQuery.status
  );
  if (rawBookingStatus && rawBookingStatus.toLowerCase() !== "all") {
    if (!ALLOWED_BOOKING_STATUSES.includes(rawBookingStatus)) {
      throw new ApiError("Invalid rental query parameters", 400, {
        code: "INVALID_BOOKING_STATUS",
      });
    }
    bookingStatus = rawBookingStatus;
  }

  let paymentStatus = "all";
  const rawPaymentStatus = readOptionalQueryString(rawQuery.paymentStatus);
  if (rawPaymentStatus && rawPaymentStatus.toLowerCase() !== "all") {
    if (!ALLOWED_PAYMENT_STATUSES.includes(rawPaymentStatus)) {
      throw new ApiError("Invalid rental query parameters", 400, {
        code: "INVALID_PAYMENT_STATUS",
      });
    }
    paymentStatus = rawPaymentStatus;
  }

  let sort = "newest";
  const rawSort = readOptionalQueryString(rawQuery.sort);
  if (rawSort) {
    if (!ALLOWED_RENTAL_SORTS.includes(rawSort)) {
      throw new ApiError("Invalid rental query parameters", 400, {
        code: "INVALID_SORT",
      });
    }
    sort = rawSort;
  }

  const page = parsePositiveIntParam(rawQuery.page, DEFAULT_RENTALS_PAGE);
  const limit = parsePositiveIntParam(
    rawQuery.limit,
    DEFAULT_RENTALS_LIMIT,
    MAX_RENTALS_LIMIT
  );

  let equipmentId = null;
  if (allowEquipmentFilter) {
    const rawEqId = readOptionalQueryString(rawQuery.equipmentId);
    if (rawEqId && rawEqId.toLowerCase() !== "all") {
      if (!isValidObjectId(rawEqId)) {
        throw new ApiError("Invalid rental query parameters", 400, {
          code: "INVALID_EQUIPMENT_FILTER",
        });
      }
      equipmentId = toObjectId(rawEqId, "equipmentId");
    }
  }

  let customerId = null;
  if (allowCustomerFilter) {
    const rawCustId = readOptionalQueryString(rawQuery.customerId);
    if (rawCustId && rawCustId.toLowerCase() !== "all") {
      if (!isValidUserIdentifier(rawCustId)) {
        throw new ApiError("Invalid rental query parameters", 400, {
          code: "INVALID_CUSTOMER_FILTER",
        });
      }
      customerId = rawCustId;
    }
  }

  let ownerId = null;
  if (allowOwnerFilter) {
    const rawOwnerId = readOptionalQueryString(rawQuery.ownerId);
    if (rawOwnerId && rawOwnerId.toLowerCase() !== "all") {
      if (!isValidUserIdentifier(rawOwnerId)) {
        throw new ApiError("Invalid rental query parameters", 400, {
          code: "INVALID_OWNER_FILTER",
        });
      }
      ownerId = rawOwnerId;
    }
  }

  return {
    search,
    bookingStatus,
    paymentStatus,
    sort,
    sortOptions: RENTAL_SORT_MAP[sort],
    page,
    limit,
    skip: (page - 1) * limit,
    equipmentId,
    customerId,
    ownerId,
  };
}
