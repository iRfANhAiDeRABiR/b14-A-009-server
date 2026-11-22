import { ObjectId } from "mongodb";
import { ApiError } from "../utils/ApiError.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function isValidObjectId(value) {
  if (value instanceof ObjectId) return true;
  if (typeof value !== "string") return false;
  return ObjectId.isValid(value.trim()) && new ObjectId(value.trim()).toString() === value.trim();
}

export function toObjectId(value, fieldName = "id") {
  if (value instanceof ObjectId) return value;
  const trimmed = cleanString(value);
  if (!trimmed || !ObjectId.isValid(trimmed)) {
    throw new ApiError(`Invalid ${fieldName}.`, 400, { code: "VALIDATION_ERROR" });
  }
  return new ObjectId(trimmed);
}

/**
 * Preserves the identifier type used by Better Auth (ObjectId or non-empty string ID).
 * Never coerces non-ObjectId Better Auth user IDs blindly into ObjectId instances.
 */
export function isValidUserIdentifier(value) {
  if (value instanceof ObjectId) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 4 && trimmed.length <= 128;
}

export function normalizeUserIdentifier(value, fieldName = "userId") {
  if (value instanceof ObjectId) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length >= 4 && trimmed.length <= 128) {
      return trimmed;
    }
  }
  throw new ApiError(`Valid ${fieldName} is required.`, 400, {
    code: "VALIDATION_ERROR",
  });
}

export function validateEmailAddress(email) {
  const clean = cleanString(email).toLowerCase();
  if (!clean || !EMAIL_PATTERN.test(clean) || clean.length > 254) {
    return null;
  }
  return clean;
}

export function isValidHttpUrl(rawUrl) {
  const clean = cleanString(rawUrl);
  if (!clean) return false;
  try {
    const parsed = new URL(clean);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function assertLengthRange(value, fieldLabel, min, max, errors) {
  const clean = cleanString(value);
  if (!clean) {
    errors.push(`${fieldLabel} is required.`);
    return clean;
  }
  if (min && clean.length < min) {
    errors.push(`${fieldLabel} must be at least ${min} characters.`);
  }
  if (max && clean.length > max) {
    errors.push(`${fieldLabel} cannot exceed ${max} characters.`);
  }
  return clean;
}
