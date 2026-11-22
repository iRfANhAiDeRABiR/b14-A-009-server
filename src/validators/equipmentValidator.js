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
  assertLengthRange,
  cleanString,
  isValidHttpUrl,
  isValidUserIdentifier,
  normalizeUserIdentifier,
} from "./validationHelpers.js";

function isValidEquipmentImage(rawImage) {
  const clean = cleanString(rawImage);
  if (!clean) return false;
  return isValidHttpUrl(clean) || clean.startsWith("/images/");
}

/**
 * Validates equipment creation payload and forces initial approval status to `Pending`.
 */
export function validateEquipmentInput(payload = {}, { requireOwnerId = true } = {}) {
  const errors = [];

  const name = assertLengthRange(
    payload.name,
    "Equipment name",
    EQUIPMENT_LIMITS.nameMin,
    EQUIPMENT_LIMITS.nameMax,
    errors
  );

  const description = assertLengthRange(
    payload.description,
    "Description",
    EQUIPMENT_LIMITS.descriptionMin,
    EQUIPMENT_LIMITS.descriptionMax,
    errors
  );

  const category = cleanString(payload.category);
  if (!EQUIPMENT_CATEGORIES.includes(category)) {
    errors.push(`Category must be one of: ${EQUIPMENT_CATEGORIES.join(", ")}.`);
  }

  const location = assertLengthRange(
    payload.location,
    "Location",
    EQUIPMENT_LIMITS.locationMin,
    EQUIPMENT_LIMITS.locationMax,
    errors
  );

  const rawPrice = Number(payload.rentalPrice);
  let rentalPrice = 0;
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    errors.push("Rental price must be a positive number.");
  } else {
    rentalPrice = roundCurrency(rawPrice);
  }

  const rentalType = cleanString(payload.rentalType);
  if (!RENTAL_TYPES.includes(rentalType)) {
    errors.push(`Rental type must be one of: ${RENTAL_TYPES.join(", ")}.`);
  }

  const rawQty = Number(payload.availableQuantity);
  if (!Number.isInteger(rawQty) || rawQty < 0) {
    errors.push("Available quantity must be a non-negative integer.");
  }

  const condition = cleanString(payload.condition);
  if (!condition || !EQUIPMENT_CONDITIONS.includes(condition)) {
    errors.push(`Condition must be one of: ${EQUIPMENT_CONDITIONS.join(", ")}.`);
  }

  const brand = cleanString(payload.brand);
  if (brand.length > EQUIPMENT_LIMITS.brandMax) {
    errors.push(`Brand cannot exceed ${EQUIPMENT_LIMITS.brandMax} characters.`);
  }

  const model = cleanString(payload.model);
  if (model.length > EQUIPMENT_LIMITS.modelMax) {
    errors.push(`Model cannot exceed ${EQUIPMENT_LIMITS.modelMax} characters.`);
  }

  const image = cleanString(payload.image);
  if (!isValidEquipmentImage(image)) {
    errors.push("A valid HTTP/HTTPS equipment image URL is required.");
  }

  const rentalTerms = assertLengthRange(
    payload.rentalTerms,
    "Rental terms",
    EQUIPMENT_LIMITS.termsMin,
    EQUIPMENT_LIMITS.termsMax,
    errors
  );

  let ownerId = null;
  if (requireOwnerId) {
    if (!isValidUserIdentifier(payload.ownerId)) {
      errors.push("Valid ownerId referencing an authenticated owner is required.");
    } else {
      ownerId = normalizeUserIdentifier(payload.ownerId, "ownerId");
    }
  }

  if (errors.length > 0) {
    throw new ApiError(errors[0], 400, {
      code: "VALIDATION_ERROR",
      details: errors,
    });
  }

  return {
    name,
    description,
    category,
    location,
    rentalPrice,
    rentalType,
    availableQuantity: rawQty,
    condition,
    brand,
    model,
    image,
    rentalTerms,
    ...(ownerId !== null ? { ownerId } : {}),
    status: DEFAULT_EQUIPMENT_STATUS,
  };
}

export function validateEquipmentApprovalStatus(status) {
  const clean = cleanString(status);
  if (!ALLOWED_EQUIPMENT_STATUSES.includes(clean)) {
    throw new ApiError(
      `Invalid equipment status. Allowed statuses: ${ALLOWED_EQUIPMENT_STATUSES.join(", ")}.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }
  return clean;
}
