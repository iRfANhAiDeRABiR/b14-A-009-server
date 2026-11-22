import { ApiError } from "../utils/ApiError.js";
import { escapeRegexInput } from "../utils/regex.js";

export const AUDIT_LOG_CATEGORIES = Object.freeze([
  "user",
  "equipment",
  "rental",
  "inquiry",
  "system",
]);

export const AUDIT_LOG_SEVERITIES = Object.freeze(["info", "warning", "danger"]);

const ALLOWED_LOG_SORTS = new Set(["newest", "oldest"]);
const DEFAULT_LOGS_PAGE = 1;
const DEFAULT_LOGS_LIMIT = 20;
const MAX_LOGS_LIMIT = 50;

function parsePositiveInteger(rawValue, label, { fallback, max } = {}) {
  if (
    rawValue === undefined ||
    rawValue === null ||
    String(rawValue).trim() === ""
  ) {
    return fallback;
  }
  const numeric = Number(rawValue);
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
 * Validates query parameters for GET /api/admin/logs.
 */
export function validateAuditLogListQuery(query = {}) {
  const searchRaw =
    query.search !== undefined && query.search !== null
      ? String(query.search).trim()
      : "";
  if (searchRaw.length > 100) {
    throw new ApiError("Search query cannot exceed 100 characters.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  let category = "all";
  if (
    query.category !== undefined &&
    query.category !== null &&
    String(query.category).trim() !== ""
  ) {
    const clean = String(query.category).trim().toLowerCase();
    if (clean === "all") {
      category = "all";
    } else if (AUDIT_LOG_CATEGORIES.includes(clean)) {
      category = clean;
    } else {
      throw new ApiError(
        `Invalid category filter. Allowed values: ${AUDIT_LOG_CATEGORIES.join(", ")}, all.`,
        400,
        { code: "VALIDATION_ERROR" }
      );
    }
  }

  let severity = "all";
  if (
    query.severity !== undefined &&
    query.severity !== null &&
    String(query.severity).trim() !== ""
  ) {
    const clean = String(query.severity).trim().toLowerCase();
    if (clean === "all") {
      severity = "all";
    } else if (AUDIT_LOG_SEVERITIES.includes(clean)) {
      severity = clean;
    } else {
      throw new ApiError(
        `Invalid severity filter. Allowed values: ${AUDIT_LOG_SEVERITIES.join(", ")}, all.`,
        400,
        { code: "VALIDATION_ERROR" }
      );
    }
  }

  let sort = "newest";
  if (
    query.sort !== undefined &&
    query.sort !== null &&
    String(query.sort).trim() !== ""
  ) {
    const cleanSort = String(query.sort).trim().toLowerCase();
    if (!ALLOWED_LOG_SORTS.has(cleanSort)) {
      throw new ApiError(
        `Invalid sort parameter. Allowed values: ${[...ALLOWED_LOG_SORTS].join(", ")}.`,
        400,
        { code: "VALIDATION_ERROR" }
      );
    }
    sort = cleanSort;
  }

  const page = parsePositiveInteger(query.page, "page", {
    fallback: DEFAULT_LOGS_PAGE,
  });
  const limit = parsePositiveInteger(query.limit, "limit", {
    fallback: DEFAULT_LOGS_LIMIT,
    max: MAX_LOGS_LIMIT,
  });

  return {
    search: searchRaw,
    escapedSearch: searchRaw ? escapeRegexInput(searchRaw) : "",
    category,
    severity,
    sort,
    page,
    limit,
  };
}
