import { ApiError } from "../utils/ApiError.js";
import { cleanString, isValidObjectId, toObjectId } from "./validationHelpers.js";

const DEFAULT_FAVORITES_PAGE = 1;
const DEFAULT_FAVORITES_LIMIT = 12;
const MAX_FAVORITES_LIMIT = 100;

/**
 * Validates an equipment ObjectId value from route params or body payloads.
 */
export function validateFavoriteEquipmentId(rawEquipmentId) {
  if (typeof rawEquipmentId !== "string") {
    throw new ApiError("Invalid equipment ID", 400, {
      code: "INVALID_EQUIPMENT_ID",
    });
  }

  const clean = cleanString(rawEquipmentId);
  if (!clean || !isValidObjectId(clean)) {
    throw new ApiError("Invalid equipment ID", 400, {
      code: "INVALID_EQUIPMENT_ID",
    });
  }

  return toObjectId(clean, "equipmentId");
}

/**
 * Validates POST /api/favorites payload without accepting untrusted user ownership fields.
 */
export function validateAddFavoritePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Invalid request body", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  return {
    equipmentId: validateFavoriteEquipmentId(payload.equipmentId),
  };
}

/**
 * Parses optional pagination parameters for GET /api/favorites without forcing pagination
 * when callers omit page and limit.
 */
export function validateFavoriteListQuery(query = {}) {
  const hasPage =
    query.page !== undefined && query.page !== null && String(query.page).trim() !== "";
  const hasLimit =
    query.limit !== undefined &&
    query.limit !== null &&
    String(query.limit).trim() !== "";

  if (!hasPage && !hasLimit) {
    return { paginate: false, page: null, limit: null, skip: 0 };
  }

  const parsePositiveInt = (rawValue, fallback, max) => {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
      return fallback;
    }
    if (typeof rawValue !== "string" && typeof rawValue !== "number") {
      throw new ApiError("Invalid pagination parameters", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    const numeric = Number(String(rawValue).trim());
    if (!Number.isInteger(numeric) || numeric < 1 || (max && numeric > max)) {
      throw new ApiError("Invalid pagination parameters", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    return numeric;
  };

  const page = parsePositiveInt(query.page, DEFAULT_FAVORITES_PAGE);
  const limit = parsePositiveInt(
    query.limit,
    DEFAULT_FAVORITES_LIMIT,
    MAX_FAVORITES_LIMIT
  );

  return {
    paginate: true,
    page,
    limit,
    skip: (page - 1) * limit,
  };
}
