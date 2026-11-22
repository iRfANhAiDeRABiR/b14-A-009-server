import { ALLOWED_USER_ROLES } from "../constants/roles.js";
import { ApiError } from "../utils/ApiError.js";
import { cleanString, isValidUserIdentifier } from "./validationHelpers.js";

const ALLOWED_USER_SORTS = new Set([
  "newest",
  "oldest",
  "name_asc",
  "name_desc",
]);

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function escapeRegexInput(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

  return {
    search: searchRaw,
    escapedSearch: searchRaw ? escapeRegexInput(searchRaw) : "",
    role,
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
