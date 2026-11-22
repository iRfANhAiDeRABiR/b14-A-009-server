import { ALLOWED_USER_ROLES, DEFAULT_USER_ROLE } from "../constants/roles.js";
import { ApiError } from "../utils/ApiError.js";
import {
  cleanString,
  isValidHttpUrl,
  validateEmailAddress,
} from "./validationHelpers.js";

/**
 * Validates allowed user profile fields for authenticated self-service updates.
 * Public signup or self-profile requests must never set privileged roles.
 */
export function validateUserProfileInput(payload = {}) {
  const errors = [];
  const clean = {};

  if (payload.role !== undefined) {
    errors.push("Role cannot be modified directly through profile updates.");
  }

  if (payload.name !== undefined) {
    const name = cleanString(payload.name);
    if (name.length < 2 || name.length > 80) {
      errors.push("Name must be between 2 and 80 characters.");
    } else {
      clean.name = name;
    }
  }

  if (payload.email !== undefined) {
    const normalizedEmail = validateEmailAddress(payload.email);
    if (!normalizedEmail) {
      errors.push("Valid email address is required.");
    } else {
      clean.email = normalizedEmail;
    }
  }

  if (payload.image !== undefined) {
    const image = cleanString(payload.image);
    if (image && !isValidHttpUrl(image)) {
      errors.push("Profile image must be a valid HTTP or HTTPS URL.");
    } else {
      clean.image = image || null;
    }
  }

  if (payload.phone !== undefined) {
    const phone = cleanString(payload.phone);
    if (phone && (phone.length < 6 || phone.length > 25)) {
      errors.push("Phone number must be between 6 and 25 characters.");
    } else {
      clean.phone = phone;
    }
  }

  if (payload.address !== undefined) {
    const address = cleanString(payload.address);
    if (address && address.length > 240) {
      errors.push("Address cannot exceed 240 characters.");
    } else {
      clean.address = address;
    }
  }

  if (errors.length > 0) {
    throw new ApiError(errors[0], 400, {
      code: "VALIDATION_ERROR",
      details: errors,
    });
  }

  return clean;
}

/**
 * Validates role assignment exclusively for authorized Admin moderation flows.
 */
export function validateUserRole(role) {
  const clean = cleanString(role);
  if (!ALLOWED_USER_ROLES.includes(clean)) {
    throw new ApiError(
      `Invalid user role. Allowed roles: ${ALLOWED_USER_ROLES.join(", ")}.`,
      400,
      { code: "VALIDATION_ERROR" }
    );
  }
  return clean;
}

/**
 * Resolves the safe public signup role regardless of client-provided parameters.
 */
export function resolveSignupRole() {
  return DEFAULT_USER_ROLE;
}
