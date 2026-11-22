import { ApiError } from "../utils/ApiError.js";
import { cleanString, isValidHttpUrl } from "./validationHelpers.js";

const ALLOWED_PROFILE_PATCH_FIELDS = new Set([
  "name",
  "image",
  "photoURL",
  "phone",
  "address",
]);

function isValidPhoneFormat(phone) {
  if (!/^\+?[0-9\s\-()]+$/.test(phone)) {
    return false;
  }
  const digitsOnly = phone.replace(/\D/g, "");
  return digitsOnly.length >= 7 && digitsOnly.length <= 15;
}

/**
 * Strictly validates PATCH /api/users/me payloads with an explicit allowlist.
 * Rejects any mass-assignment attempts (`role`, `email`, `emailVerified`, `password`,
 * `userId`, etc.) rather than ignoring unauthorized privilege modifications.
 */
export function validateProfileUpdatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Invalid request data", 400, { code: "VALIDATION_ERROR" });
  }

  const submittedKeys = Object.keys(payload);
  if (submittedKeys.length === 0) {
    throw new ApiError("Provide at least one profile field to update.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  const disallowedKeys = submittedKeys.filter(
    (key) => !ALLOWED_PROFILE_PATCH_FIELDS.has(key)
  );
  if (disallowedKeys.length > 0) {
    throw new ApiError(
      `Unsupported or restricted field(s): ${disallowedKeys.join(", ")}.`,
      400,
      { code: "FORBIDDEN_FIELD_UPDATE" }
    );
  }

  const errors = [];
  const updateFields = {};

  if (payload.name !== undefined) {
    if (typeof payload.name !== "string") {
      errors.push("Name must be a string.");
    } else {
      const name = cleanString(payload.name);
      if (!name || name.length < 2 || name.length > 80) {
        errors.push("Name must be between 2 and 80 characters.");
      } else {
        updateFields.name = name;
      }
    }
  }

  const hasImageKey = payload.image !== undefined || payload.photoURL !== undefined;
  if (hasImageKey) {
    const rawImage = payload.image !== undefined ? payload.image : payload.photoURL;
    if (rawImage === null) {
      updateFields.image = null;
    } else if (typeof rawImage !== "string") {
      errors.push("Profile image must be a valid URL string.");
    } else {
      const cleanImage = cleanString(rawImage);
      if (!cleanImage) {
        updateFields.image = null;
      } else if (!isValidHttpUrl(cleanImage)) {
        errors.push("Profile image must be a valid HTTP or HTTPS URL.");
      } else {
        updateFields.image = cleanImage;
      }
    }
  }

  if (payload.phone !== undefined) {
    if (typeof payload.phone !== "string") {
      errors.push("Phone number must be a string.");
    } else {
      const phone = cleanString(payload.phone);
      if (!phone) {
        updateFields.phone = "";
      } else if (!isValidPhoneFormat(phone)) {
        errors.push(
          "Enter a valid phone number (7 to 15 digits, e.g., 01XXXXXXXXX)."
        );
      } else {
        updateFields.phone = phone;
      }
    }
  }

  if (payload.address !== undefined) {
    if (typeof payload.address !== "string") {
      errors.push("Address must be a string.");
    } else {
      const address = cleanString(payload.address);
      if (address.length > 250) {
        errors.push("Address cannot exceed 250 characters.");
      } else {
        updateFields.address = address;
      }
    }
  }

  if (errors.length > 0) {
    throw new ApiError(errors[0], 400, {
      code: "VALIDATION_ERROR",
      details: errors,
    });
  }

  return updateFields;
}
