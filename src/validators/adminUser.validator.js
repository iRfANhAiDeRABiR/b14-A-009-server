import { ALLOWED_USER_ROLES } from "../constants/roles.js";
import { ApiError } from "../utils/ApiError.js";
import { escapeRegexInput } from "../utils/regex.js";
import { cleanString, isValidUserIdentifier } from "./validationHelpers.js";

const ALLOWED_USER_SORTS = new Set([
  "newest",
  "oldest",
  "name_asc",
  "name_desc",
]);

export const ADMIN_USER_ACCOUNT_STATUSES = Object.freeze([
  "Active",
  "Suspended",
  "Banned",
]);

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export { escapeRegexInput };

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

/**
 * Validates query parameters for GET /api/admin/users cleanly without executing unsafe patterns.
 */
export function validateAdminUserListQuery(query = {}) {
  const searchRaw =
    query.search !== undefined && query.search !== null ? String(query.search).trim() : "";
  if (searchRaw.length > 100) {
    throw new ApiError("Search query cannot exceed 100 characters.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  let role = "all";
  if (query.role !== undefined && query.role !== null && String(query.role).trim() !== "") {
    const cleanRole = String(query.role).trim();
    if (cleanRole.toLowerCase() === "all") {
      role = "all";
    } else if (ALLOWED_USER_ROLES.includes(cleanRole)) {
      role = cleanRole;
    } else {
      throw new ApiError(
        `Invalid role filter. Allowed values: ${ALLOWED_USER_ROLES.join(", ")}, all.`,
        400,
        { code: "VALIDATION_ERROR" }
      );
    }
  }

  let sort = "newest";
  if (query.sort !== undefined && query.sort !== null && String(query.sort).trim() !== "") {
    const cleanSort = String(query.sort).trim();
    if (!ALLOWED_USER_SORTS.has(cleanSort)) {
      throw new ApiError(
        `Invalid sort parameter. Allowed values: ${[...ALLOWED_USER_SORTS].join(", ")}.`,
        400,
        { code: "VALIDATION_ERROR" }
      );
    }
    sort = cleanSort;
  }

  const page = parsePositiveInteger(query.page, "page", { fallback: DEFAULT_PAGE });
  const limit = parsePositiveInteger(query.limit, "limit", {
    fallback: DEFAULT_LIMIT,
    max: MAX_LIMIT,
  });

  let status = "all";
  if (query.status !== undefined && query.status !== null && String(query.status).trim() !== "") {
    const cleanStatus = String(query.status).trim();
    if (cleanStatus.toLowerCase() === "all") {
      status = "all";
    } else {
      const matched = ADMIN_USER_ACCOUNT_STATUSES.find(
        (item) => item.toLowerCase() === cleanStatus.toLowerCase()
      );
      if (!matched) {
        throw new ApiError(
          `Invalid status filter. Allowed values: ${ADMIN_USER_ACCOUNT_STATUSES.join(", ")}, all.`,
          400,
          { code: "VALIDATION_ERROR" }
        );
      }
      status = matched;
    }
  }

  return {
    search: searchRaw,
    escapedSearch: searchRaw ? escapeRegexInput(searchRaw) : "",
    role,
    status,
    sort,
    page,
    limit,
  };
}

/**
 * Validates target user ID route parameter matching Better Auth string or ObjectId IDs.
 */
export function validateAdminTargetUserId(rawUserId) {
  const cleanId = cleanString(rawUserId);
  if (!isValidUserIdentifier(cleanId) || /[\0\r\n$]/.test(cleanId)) {
    throw new ApiError("Invalid user ID parameter.", 400, {
      code: "VALIDATION_ERROR",
    });
  }
  return cleanId;
}

/**
 * Validates PATCH /api/admin/users/:id/role request body strictly.
 */
export function validateAdminRoleUpdateBody(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Invalid request data", 400, { code: "VALIDATION_ERROR" });
  }

  const keys = Object.keys(payload);
  const disallowed = keys.filter((k) => k !== "role");
  if (disallowed.length > 0) {
    throw new ApiError(
      `Only the 'role' field can be updated on this endpoint.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }

  if (typeof payload.role !== "string" || !payload.role.trim()) {
    throw new ApiError("Role is required and must be a valid string.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const role = payload.role.trim();
  if (!ALLOWED_USER_ROLES.includes(role)) {
    throw new ApiError(
      `Invalid role. Allowed roles: ${ALLOWED_USER_ROLES.join(", ")}.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }

  return role;
}

/**
 * Validates PATCH /api/admin/users/:id/status request body.
 */
export function validateAdminUserStatusBody(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Invalid request data", 400, { code: "VALIDATION_ERROR" });
  }

  const allowedKeys = new Set(["status", "reason"]);
  const disallowed = Object.keys(payload).filter((k) => !allowedKeys.has(k));
  if (disallowed.length > 0) {
    throw new ApiError(
      `Unsupported field(s) in status update payload: ${disallowed.join(", ")}.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }

  if (typeof payload.status !== "string" || !payload.status.trim()) {
    throw new ApiError("Account status is required.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const matched = ADMIN_USER_ACCOUNT_STATUSES.find(
    (item) => item.toLowerCase() === payload.status.trim().toLowerCase()
  );
  if (!matched) {
    throw new ApiError(
      `Invalid status. Allowed values: ${ADMIN_USER_ACCOUNT_STATUSES.join(", ")}.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }

  let reason = "";
  if (payload.reason !== undefined && payload.reason !== null) {
    if (typeof payload.reason !== "string") {
      throw new ApiError("Status reason must be a string.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    reason = cleanString(payload.reason);
    if (reason.length > 300) {
      throw new ApiError("Status reason cannot exceed 300 characters.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
  }

  return { status: matched, reason };
}

/**
 * Validates PATCH /api/admin/users/:id safe profile metadata updates.
 */
export function validateAdminUserProfileUpdateBody(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Invalid request data", 400, { code: "VALIDATION_ERROR" });
  }

  const allowedKeys = new Set(["name", "phone", "address"]);
  const keys = Object.keys(payload);
  const disallowed = keys.filter((k) => !allowedKeys.has(k));
  if (disallowed.length > 0) {
    throw new ApiError(
      `Disallowed field(s) for Admin profile edit: ${disallowed.join(", ")}.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }

  if (keys.length === 0) {
    throw new ApiError("Provide at least one editable field (name, phone, address).", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const clean = {};

  if (payload.name !== undefined) {
    if (typeof payload.name !== "string") {
      throw new ApiError("Name must be a valid string.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    const cleanName = cleanString(payload.name);
    if (cleanName.length < 2 || cleanName.length > 80) {
      throw new ApiError("Name must be between 2 and 80 characters.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    clean.name = cleanName;
  }

  if (payload.phone !== undefined) {
    if (typeof payload.phone !== "string") {
      throw new ApiError("Phone number must be a string.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    const cleanPhone = cleanString(payload.phone);
    if (cleanPhone && (cleanPhone.length < 6 || cleanPhone.length > 25)) {
      throw new ApiError("Phone number must be between 6 and 25 characters.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    clean.phone = cleanPhone;
  }

  if (payload.address !== undefined) {
    if (typeof payload.address !== "string") {
      throw new ApiError("Address must be a string.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    const cleanAddress = cleanString(payload.address);
    if (cleanAddress.length > 240) {
      throw new ApiError("Address cannot exceed 240 characters.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    clean.address = cleanAddress;
  }

  return clean;
}
