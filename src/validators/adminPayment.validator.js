import { ALLOWED_PAYMENT_STATUSES } from "../constants/payment.js";
import { ApiError } from "../utils/ApiError.js";
import { escapeRegexInput } from "../utils/regex.js";
import { isValidUserIdentifier } from "./validationHelpers.js";

export const ADMIN_PAYMENT_SORTS = Object.freeze([
  "newest",
  "oldest",
  "amount_high",
  "amount_low",
]);

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const MAX_SEARCH_LENGTH = 100;

function readString(rawValue) {
  if (rawValue === undefined || rawValue === null) return "";
  if (typeof rawValue !== "string" && typeof rawValue !== "number") {
    throw new ApiError("Invalid payment query parameters.", 400, {
      code: "VALIDATION_ERROR",
    });
  }
  return String(rawValue).trim();
}

function parsePositiveInt(rawValue, label, { fallback, max } = {}) {
  const clean = readString(rawValue);
  if (!clean) return fallback;
  const numeric = Number(clean);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new ApiError(`${label} must be a positive integer.`, 400, {
      code: "VALIDATION_ERROR",
    });
  }
  if (max && numeric > max) {
    throw new ApiError(`${label} cannot exceed ${max}.`, 400, {
      code: "VALIDATION_ERROR",
    });
  }
  return numeric;
}

/**
 * Validates query parameters for GET /api/admin/payments.
 * Rejects operator-style keys (e.g. `status[$ne]`) and unknown enum values.
 */
export function validateAdminPaymentListQuery(query = {}) {
  for (const [key, value] of Object.entries(query || {})) {
    if (
      key.includes("$") ||
      key.includes("[") ||
      (value !== null && typeof value === "object")
    ) {
      throw new ApiError("Invalid payment query parameters.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
  }

  const search = readString(query.search);
  if (search.length > MAX_SEARCH_LENGTH) {
    throw new ApiError(
      `Search query cannot exceed ${MAX_SEARCH_LENGTH} characters.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }

  let status = "all";
  const rawStatus = readString(query.status);
  if (rawStatus && rawStatus.toLowerCase() !== "all") {
    const match = ALLOWED_PAYMENT_STATUSES.find(
      (allowed) => allowed.toLowerCase() === rawStatus.toLowerCase()
    );
    if (!match) {
      throw new ApiError(
        `Invalid status filter. Allowed values: ${ALLOWED_PAYMENT_STATUSES.join(", ")}, all.`,
        400,
        { code: "VALIDATION_ERROR" }
      );
    }
    status = match;
  }

  let sort = "newest";
  const rawSort = readString(query.sort);
  if (rawSort) {
    const cleanSort = rawSort.toLowerCase();
    if (!ADMIN_PAYMENT_SORTS.includes(cleanSort)) {
      throw new ApiError(
        `Invalid sort parameter. Allowed values: ${ADMIN_PAYMENT_SORTS.join(", ")}.`,
        400,
        { code: "VALIDATION_ERROR" }
      );
    }
    sort = cleanSort;
  }

  let customerId = null;
  const rawCustomerId = readString(query.customerId);
  if (rawCustomerId && rawCustomerId.toLowerCase() !== "all") {
    if (!isValidUserIdentifier(rawCustomerId)) {
      throw new ApiError("Invalid customerId filter.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    customerId = rawCustomerId;
  }

  const page = parsePositiveInt(query.page, "page", { fallback: DEFAULT_PAGE });
  const limit = parsePositiveInt(query.limit, "limit", {
    fallback: DEFAULT_LIMIT,
    max: MAX_LIMIT,
  });

  return {
    search,
    escapedSearch: search ? escapeRegexInput(search) : "",
    status,
    sort,
    customerId,
    page,
    limit,
    skip: (page - 1) * limit,
  };
}
