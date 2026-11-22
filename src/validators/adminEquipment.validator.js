import {
  ALLOWED_EQUIPMENT_STATUSES,
  EQUIPMENT_CATEGORIES,
} from "../constants/equipment.js";
import { ApiError } from "../utils/ApiError.js";
import {
  parseEquipmentPaginationQuery,
  validateEquipmentObjectId,
  validateEquipmentPatchPayload,
} from "./equipment.validator.js";

export const ALLOWED_ADMIN_EQUIPMENT_SORTS = Object.freeze([
  "newest",
  "oldest",
  "price_asc",
  "price_desc",
]);

export const ADMIN_EQUIPMENT_SORT_MAP = Object.freeze({
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  price_asc: { rentalPrice: 1, _id: -1 },
  price_desc: { rentalPrice: -1, _id: -1 },
});

const REJECTION_REASON_MIN = 3;
const REJECTION_REASON_MAX = 500;
const MAX_ADMIN_EQUIPMENT_SEARCH = 120;

function assertNoOperatorQueryKeys(rawQuery) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    return;
  }

  for (const [key, value] of Object.entries(rawQuery)) {
    if (key.startsWith("$") || /\[\s*\$/.test(key)) {
      throw new ApiError("Invalid equipment query parameters", 400, {
        code: "INVALID_QUERY_PARAMS",
      });
    }
    if (value !== null && typeof value === "object") {
      throw new ApiError("Invalid equipment query parameters", 400, {
        code: "INVALID_QUERY_PARAMS",
      });
    }
  }
}

export function validateAdminEquipmentQuery(rawQuery = {}) {
  assertNoOperatorQueryKeys(rawQuery);

  const search =
    typeof rawQuery.search === "string"
      ? rawQuery.search.trim()
      : rawQuery.search === undefined || rawQuery.search === null
        ? ""
        : null;

  if (search === null) {
    throw new ApiError("Invalid equipment query parameters", 400, {
      code: "VALIDATION_ERROR",
    });
  }
  if (search.length > MAX_ADMIN_EQUIPMENT_SEARCH) {
    throw new ApiError("Search query cannot exceed 120 characters.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const rawCategory =
    typeof rawQuery.category === "string"
      ? rawQuery.category.trim()
      : rawQuery.category === undefined || rawQuery.category === null
        ? ""
        : null;
  if (rawCategory === null) {
    throw new ApiError("Invalid equipment category", 400, {
      code: "INVALID_CATEGORY",
    });
  }

  let category = "all";
  if (rawCategory && rawCategory.toLowerCase() !== "all") {
    if (!EQUIPMENT_CATEGORIES.includes(rawCategory)) {
      throw new ApiError("Invalid equipment category", 400, {
        code: "INVALID_CATEGORY",
      });
    }
    category = rawCategory;
  }

  const rawSort =
    typeof rawQuery.sort === "string"
      ? rawQuery.sort.trim()
      : rawQuery.sort === undefined || rawQuery.sort === null
        ? ""
        : null;
  if (rawSort === null) {
    throw new ApiError("Invalid sorting option", 400, {
      code: "INVALID_SORT",
    });
  }

  let sort = "newest";
  if (rawSort) {
    if (!ALLOWED_ADMIN_EQUIPMENT_SORTS.includes(rawSort)) {
      throw new ApiError("Invalid sorting option", 400, {
        code: "INVALID_SORT",
      });
    }
    sort = rawSort;
  }

  const { page, limit, status } = parseEquipmentPaginationQuery(rawQuery, {
    defaultLimit: 10,
    maxLimit: 50,
    allowStatus: true,
  });

  if (status !== "all" && !ALLOWED_EQUIPMENT_STATUSES.includes(status)) {
    throw new ApiError("Invalid equipment status filter", 400, {
      code: "INVALID_STATUS",
    });
  }

  return {
    search,
    category,
    status,
    sort,
    sortOptions: ADMIN_EQUIPMENT_SORT_MAP[sort],
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

export function validateAdminRejectPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Rejection reason is required.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const rawReason =
    payload.rejectionReason !== undefined ? payload.rejectionReason : payload.reason;

  if (typeof rawReason !== "string") {
    throw new ApiError("Rejection reason is required.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const cleanReason = rawReason.trim();
  if (!cleanReason) {
    throw new ApiError("Rejection reason is required.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  if (cleanReason.length < REJECTION_REASON_MIN) {
    throw new ApiError(
      `Rejection reason must be at least ${REJECTION_REASON_MIN} characters.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }
  if (cleanReason.length > REJECTION_REASON_MAX) {
    throw new ApiError(
      `Rejection reason cannot exceed ${REJECTION_REASON_MAX} characters.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }

  return { rejectionReason: cleanReason };
}

export { validateEquipmentObjectId, validateEquipmentPatchPayload };
