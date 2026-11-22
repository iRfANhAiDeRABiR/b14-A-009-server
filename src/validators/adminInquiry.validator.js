import {
  ALLOWED_CONTACT_MESSAGE_STATUSES,
  CONTACT_INQUIRY_TYPES,
} from "../constants/booking.js";
import { ApiError } from "../utils/ApiError.js";
import { escapeRegexInput } from "../utils/regex.js";
import { cleanString, isValidObjectId, toObjectId } from "./validationHelpers.js";

const ALLOWED_INQUIRY_SORTS = new Set(["newest", "oldest"]);
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function parsePositiveInteger(rawValue, label, { fallback, max } = {}) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
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

export function validateAdminInquiryIdParam(rawId) {
  const clean = cleanString(rawId);
  if (!clean || !isValidObjectId(clean)) {
    throw new ApiError("Invalid inquiry ID parameter.", 400, {
      code: "VALIDATION_ERROR",
    });
  }
  return toObjectId(clean, "inquiryId");
}

export function validateAdminInquiryListQuery(query = {}) {
  const searchRaw =
    query.search !== undefined && query.search !== null ? String(query.search).trim() : "";
  if (searchRaw.length > 100) {
    throw new ApiError("Search query cannot exceed 100 characters.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  let status = "all";
  if (query.status !== undefined && query.status !== null && String(query.status).trim() !== "") {
    const clean = String(query.status).trim();
    if (clean.toLowerCase() === "all") {
      status = "all";
    } else {
      const matched = ALLOWED_CONTACT_MESSAGE_STATUSES.find(
        (s) => s.toLowerCase() === clean.toLowerCase()
      );
      if (!matched) {
        throw new ApiError(
          `Invalid status filter. Allowed values: ${ALLOWED_CONTACT_MESSAGE_STATUSES.join(", ")}, all.`,
          400,
          { code: "VALIDATION_ERROR" }
        );
      }
      status = matched;
    }
  }

  let inquiryType = "all";
  if (
    query.inquiryType !== undefined &&
    query.inquiryType !== null &&
    String(query.inquiryType).trim() !== ""
  ) {
    const clean = String(query.inquiryType).trim();
    if (clean.toLowerCase() === "all") {
      inquiryType = "all";
    } else {
      const matched = CONTACT_INQUIRY_TYPES.find(
        (t) => t.toLowerCase() === clean.toLowerCase()
      );
      if (!matched) {
        throw new ApiError(
          `Invalid inquiryType filter. Allowed values: ${CONTACT_INQUIRY_TYPES.join(", ")}, all.`,
          400,
          { code: "VALIDATION_ERROR" }
        );
      }
      inquiryType = matched;
    }
  }

  let sort = "newest";
  if (query.sort !== undefined && query.sort !== null && String(query.sort).trim() !== "") {
    const cleanSort = String(query.sort).trim().toLowerCase();
    if (!ALLOWED_INQUIRY_SORTS.has(cleanSort)) {
      throw new ApiError(
        `Invalid sort parameter. Allowed values: ${[...ALLOWED_INQUIRY_SORTS].join(", ")}.`,
        400,
        { code: "VALIDATION_ERROR" }
      );
    }
    sort = cleanSort;
  }

  return {
    search: searchRaw,
    escapedSearch: searchRaw ? escapeRegexInput(searchRaw) : "",
    status,
    inquiryType,
    sort,
    page: parsePositiveInteger(query.page, "page", { fallback: DEFAULT_PAGE }),
    limit: parsePositiveInteger(query.limit, "limit", {
      fallback: DEFAULT_LIMIT,
      max: MAX_LIMIT,
    }),
  };
}

export function validateAdminInquiryStatusBody(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Invalid request data", 400, { code: "VALIDATION_ERROR" });
  }

  const allowedKeys = new Set(["status", "adminNote"]);
  const disallowed = Object.keys(payload).filter((k) => !allowedKeys.has(k));
  if (disallowed.length > 0) {
    throw new ApiError(
      `Unsupported field(s) in inquiry update: ${disallowed.join(", ")}.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }

  const matched = ALLOWED_CONTACT_MESSAGE_STATUSES.find(
    (s) => s.toLowerCase() === String(payload.status || "").trim().toLowerCase()
  );
  if (!matched) {
    throw new ApiError(
      `Invalid status. Allowed values: ${ALLOWED_CONTACT_MESSAGE_STATUSES.join(", ")}.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }

  let adminNote = "";
  if (payload.adminNote !== undefined && payload.adminNote !== null) {
    if (typeof payload.adminNote !== "string") {
      throw new ApiError("Admin note must be a string.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    adminNote = cleanString(payload.adminNote);
    if (adminNote.length > 500) {
      throw new ApiError("Admin note cannot exceed 500 characters.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
  }

  return { status: matched, adminNote };
}
