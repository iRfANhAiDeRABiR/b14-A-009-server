import {
  ALLOWED_EQUIPMENT_STATUSES,
  DEFAULT_EQUIPMENT_STATUS,
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_CONDITIONS,
  EQUIPMENT_LIMITS,
  RENTAL_TYPES,
} from "../constants/equipment.js";
import { roundCurrency } from "../constants/payment.js";
import { ApiError } from "../utils/ApiError.js";
import {
  cleanString,
  isValidHttpUrl,
  isValidObjectId,
  toObjectId,
} from "./validationHelpers.js";

const EQUIPMENT_EDITABLE_FIELDS = new Set([
  "name",
  "description",
  "category",
  "location",
  "rentalPrice",
  "rentalType",
  "availableQuantity",
  "condition",
  "brand",
  "model",
  "image",
  "rentalTerms",
]);

function validateStringField(rawValue, label, { min = 1, max = 150, errors }) {
  if (typeof rawValue !== "string") {
    errors.push(`${label} must be a string.`);
    return "";
  }
  const clean = cleanString(rawValue);
  if (!clean) {
    errors.push(`${label} is required.`);
    return "";
  }
  if (clean.length < min) {
    errors.push(`${label} must be at least ${min} characters.`);
  }
  if (clean.length > max) {
    errors.push(`${label} cannot exceed ${max} characters.`);
  }
  return clean;
}

function validateEnumField(rawValue, allowedList, label, errors) {
  if (typeof rawValue !== "string") {
    errors.push(`${label} must be a valid string.`);
    return "";
  }
  const clean = cleanString(rawValue);
  if (!allowedList.includes(clean)) {
    errors.push(`${label} must be one of: ${allowedList.join(", ")}.`);
  }
  return clean;
}

function validateEquipmentFieldsSubset(payload, keysToValidate) {
  const errors = [];
  const clean = {};

  if (keysToValidate.includes("name")) {
    clean.name = validateStringField(payload.name, "Equipment name", {
      min: EQUIPMENT_LIMITS.nameMin,
      max: EQUIPMENT_LIMITS.nameMax,
      errors,
    });
  }

  if (keysToValidate.includes("description")) {
    clean.description = validateStringField(payload.description, "Description", {
      min: EQUIPMENT_LIMITS.descriptionMin,
      max: EQUIPMENT_LIMITS.descriptionMax,
      errors,
    });
  }

  if (keysToValidate.includes("category")) {
    clean.category = validateEnumField(
      payload.category,
      EQUIPMENT_CATEGORIES,
      "Category",
      errors
    );
  }

  if (keysToValidate.includes("location")) {
    clean.location = validateStringField(payload.location, "Location", {
      min: EQUIPMENT_LIMITS.locationMin,
      max: EQUIPMENT_LIMITS.locationMax,
      errors,
    });
  }

  if (keysToValidate.includes("rentalPrice")) {
    const raw = payload.rentalPrice;
    const numeric =
      raw === "" || raw === null || typeof raw === "boolean" ? NaN : Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      errors.push("Rental price must be a positive number.");
    } else {
      clean.rentalPrice = roundCurrency(numeric);
    }
  }

  if (keysToValidate.includes("rentalType")) {
    clean.rentalType = validateEnumField(
      payload.rentalType,
      RENTAL_TYPES,
      "Rental type",
      errors
    );
  }

  if (keysToValidate.includes("availableQuantity")) {
    const raw = payload.availableQuantity;
    const numeric =
      raw === "" || raw === null || typeof raw === "boolean" ? NaN : Number(raw);
    if (!Number.isInteger(numeric) || numeric < 1) {
      errors.push("Available quantity must be a positive integer of at least 1.");
    } else {
      clean.availableQuantity = numeric;
    }
  }

  if (keysToValidate.includes("condition")) {
    clean.condition = validateEnumField(
      payload.condition,
      EQUIPMENT_CONDITIONS,
      "Condition",
      errors
    );
  }

  if (keysToValidate.includes("brand")) {
    clean.brand = validateStringField(payload.brand, "Brand", {
      min: 1,
      max: EQUIPMENT_LIMITS.brandMax,
      errors,
    });
  }

  if (keysToValidate.includes("model")) {
    clean.model = validateStringField(payload.model, "Model", {
      min: 1,
      max: EQUIPMENT_LIMITS.modelMax,
      errors,
    });
  }

  if (keysToValidate.includes("image")) {
    const rawImg = cleanString(payload.image);
    if (!rawImg || !isValidHttpUrl(rawImg)) {
      errors.push("Equipment image must be a valid HTTP or HTTPS URL.");
    } else {
      clean.image = rawImg;
    }
  }

  if (keysToValidate.includes("rentalTerms")) {
    clean.rentalTerms = validateStringField(payload.rentalTerms, "Rental terms", {
      min: EQUIPMENT_LIMITS.termsMin,
      max: EQUIPMENT_LIMITS.termsMax,
      errors,
    });
  }

  if (errors.length > 0) {
    throw new ApiError(errors[0], 400, {
      code: "VALIDATION_ERROR",
      details: errors,
    });
  }

  return clean;
}

function assertAllowedEquipmentPayloadKeys(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Invalid equipment information", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const submittedKeys = Object.keys(payload);
  const disallowed = submittedKeys.filter(
    (key) => !EQUIPMENT_EDITABLE_FIELDS.has(key)
  );
  if (disallowed.length > 0) {
    throw new ApiError(
      `Restricted or unsupported equipment field(s): ${disallowed.join(", ")}.`,
      400,
      { code: "FORBIDDEN_FIELD_UPDATE" }
    );
  }
  return submittedKeys;
}

/**
 * Strictly validates POST /api/equipment owner submission payloads.
 * Rejects restricted fields (`ownerId`, `status`, etc.) and enforces Pending default.
 */
export function validateEquipmentCreatePayload(payload) {
  assertAllowedEquipmentPayloadKeys(payload);
  const requiredKeys = [...EQUIPMENT_EDITABLE_FIELDS];
  const validated = validateEquipmentFieldsSubset(payload, requiredKeys);
  return {
    ...validated,
    status: DEFAULT_EQUIPMENT_STATUS,
  };
}

/**
 * Strictly validates PATCH /api/equipment/:id owner update payloads.
 */
export function validateEquipmentPatchPayload(payload) {
  const submittedKeys = assertAllowedEquipmentPayloadKeys(payload);
  if (submittedKeys.length === 0) {
    throw new ApiError("Provide at least one equipment field to update.", 400, {
      code: "VALIDATION_ERROR",
    });
  }
  return validateEquipmentFieldsSubset(payload, submittedKeys);
}

/**
 * Validates MongoDB ObjectId parameters for equipment detail/update/delete routes.
 */
export function validateEquipmentObjectId(rawId) {
  const clean = cleanString(rawId);
  if (!clean || !isValidObjectId(clean)) {
    throw new ApiError("Invalid equipment ID format.", 400, {
      code: "INVALID_OBJECT_ID",
    });
  }
  return toObjectId(clean, "equipmentId");
}

/**
 * Parses positive pagination bounds cleanly without loading full collections into memory.
 */
export function parseEquipmentPaginationQuery(
  query = {},
  { defaultLimit = 9, maxLimit = 50, allowStatus = false } = {}
) {
  const parsePosInt = (val, label, fallback, max) => {
    if (val === undefined || val === null || String(val).trim() === "") {
      return fallback;
    }
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1) {
      throw new ApiError(`${label} must be a positive integer.`, 400, {
        code: "VALIDATION_ERROR",
      });
    }
    if (max && n > max) {
      throw new ApiError(`${label} cannot exceed ${max}.`, 400, {
        code: "VALIDATION_ERROR",
      });
    }
    return n;
  };

  const page = parsePosInt(query.page, "page", 1);
  const limit = parsePosInt(query.limit, "limit", defaultLimit, maxLimit);

  let status = "all";
  if (allowStatus && query.status !== undefined && String(query.status).trim() !== "") {
    const cleanStatus = String(query.status).trim();
    if (cleanStatus.toLowerCase() === "all") {
      status = "all";
    } else if (ALLOWED_EQUIPMENT_STATUSES.includes(cleanStatus)) {
      status = cleanStatus;
    } else {
      throw new ApiError(
        `Invalid status filter. Allowed values: ${ALLOWED_EQUIPMENT_STATUSES.join(", ")}, all.`,
        400,
        { code: "VALIDATION_ERROR" }
      );
    }
  }

  return { page, limit, status };
}
