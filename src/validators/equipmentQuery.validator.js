import { EQUIPMENT_CATEGORIES, RENTAL_TYPES } from "../constants/equipment.js";
import { ApiError } from "../utils/ApiError.js";

export const ALLOWED_AVAILABILITY_FILTERS = Object.freeze([
  "available",
  "unavailable",
]);

export const ALLOWED_EQUIPMENT_SORTS = Object.freeze([
  "newest",
  "price_asc",
  "price_desc",
  "featured",
]);

export const DEFAULT_EQUIPMENT_PAGE = 1;
export const DEFAULT_EQUIPMENT_LIMIT = 9;
export const MAX_EQUIPMENT_LIMIT = 50;
export const MAX_EQUIPMENT_SEARCH_LENGTH = 120;

function readQueryStringParam(rawValue, errorMessage) {
  if (rawValue === undefined || rawValue === null) {
    return "";
  }
  if (typeof rawValue !== "string") {
    throw new ApiError(errorMessage, 400, { code: "VALIDATION_ERROR" });
  }
  return rawValue.trim();
}

function parsePriceBound(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }
  if (typeof rawValue !== "string" && typeof rawValue !== "number") {
    throw new ApiError("Invalid price range", 400, { code: "VALIDATION_ERROR" });
  }

  const trimmed = String(rawValue).trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError("Invalid price range", 400, { code: "VALIDATION_ERROR" });
  }

  return parsed;
}

function parsePositiveIntegerQuery(rawValue, fallback, max) {
  if (rawValue === undefined || rawValue === null) {
    return fallback;
  }
  if (typeof rawValue !== "string" && typeof rawValue !== "number") {
    throw new ApiError("Invalid pagination parameters", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const trimmed = String(rawValue).trim();
  if (!trimmed) {
    return fallback;
  }

  const numeric = Number(trimmed);
  if (!Number.isInteger(numeric) || numeric < 1 || (max && numeric > max)) {
    throw new ApiError("Invalid pagination parameters", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  return numeric;
}

function assertNoQueryOperatorKeys(rawQuery) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    return;
  }

  for (const [key, value] of Object.entries(rawQuery)) {
    if (key.startsWith("$") || /\[\s*\$/.test(key)) {
      throw new ApiError("Invalid query parameters.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
    if (value !== null && typeof value === "object") {
      throw new ApiError("Invalid query parameters.", 400, {
        code: "VALIDATION_ERROR",
      });
    }
  }
}

/**
 * Validates and normalizes public catalog query parameters strictly without accepting
 * raw MongoDB query operators, arbitrary field names, or status overrides.
 */
export function validateEquipmentListQuery(rawQuery = {}) {
  assertNoQueryOperatorKeys(rawQuery);

  const search = readQueryStringParam(
    rawQuery.search,
    "Search parameter must be text."
  );
  if (search.length > MAX_EQUIPMENT_SEARCH_LENGTH) {
    throw new ApiError(
      `Search query cannot exceed ${MAX_EQUIPMENT_SEARCH_LENGTH} characters.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }

  const rawCategory = readQueryStringParam(
    rawQuery.category,
    "Invalid equipment category"
  );
  let category = "all";
  if (rawCategory && rawCategory.toLowerCase() !== "all") {
    if (!EQUIPMENT_CATEGORIES.includes(rawCategory)) {
      throw new ApiError("Invalid equipment category", 400, {
        code: "INVALID_CATEGORY",
      });
    }
    category = rawCategory;
  }

  const rawRentalType = readQueryStringParam(
    rawQuery.rentalType,
    "Invalid rental type"
  );
  let rentalType = "all";
  if (rawRentalType && rawRentalType.toLowerCase() !== "all") {
    if (!RENTAL_TYPES.includes(rawRentalType)) {
      throw new ApiError("Invalid rental type", 400, {
        code: "INVALID_RENTAL_TYPE",
      });
    }
    rentalType = rawRentalType;
  }

  const minPrice = parsePriceBound(rawQuery.minPrice);
  const maxPrice = parsePriceBound(rawQuery.maxPrice);
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    throw new ApiError("Invalid price range", 400, {
      code: "INVALID_PRICE_RANGE",
    });
  }

  const rawAvailability = readQueryStringParam(
    rawQuery.availability,
    "Invalid availability filter"
  ).toLowerCase();
  let availability = "all";
  if (rawAvailability && rawAvailability !== "all") {
    if (!ALLOWED_AVAILABILITY_FILTERS.includes(rawAvailability)) {
      throw new ApiError("Invalid availability filter", 400, {
        code: "INVALID_AVAILABILITY",
      });
    }
    availability = rawAvailability;
  }

  const rawSort = readQueryStringParam(
    rawQuery.sort,
    "Invalid sorting option"
  );
  let sort = "newest";
  if (rawSort) {
    if (!ALLOWED_EQUIPMENT_SORTS.includes(rawSort)) {
      throw new ApiError("Invalid sorting option", 400, {
        code: "INVALID_SORT",
      });
    }
    sort = rawSort;
  }

  const page = parsePositiveIntegerQuery(rawQuery.page, DEFAULT_EQUIPMENT_PAGE);
  const limit = parsePositiveIntegerQuery(
    rawQuery.limit,
    DEFAULT_EQUIPMENT_LIMIT,
    MAX_EQUIPMENT_LIMIT
  );

  return {
    search,
    category,
    rentalType,
    minPrice,
    maxPrice,
    availability,
    sort,
    page,
    limit,
  };
}
