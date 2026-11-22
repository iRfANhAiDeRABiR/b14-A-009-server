import { DEFAULT_USER_ROLE } from "../constants/roles.js";
import { getUsersCollection } from "./collections.js";
import { validateUserProfileInput } from "../validators/userValidator.js";

/**
 * @typedef {import("mongodb").ObjectId | string} UserIdentifier
 *
 * @typedef {Object} UserDocument
 * @property {UserIdentifier} _id - Better Auth / MongoDB primary user identifier
 * @property {string} [id] - String alias mapped by Better Auth when present
 * @property {string} name
 * @property {string} email
 * @property {boolean} emailVerified
 * @property {string|null} image
 * @property {string} [phone]
 * @property {string} [address]
 * @property {"Customer"|"Owner"|"Admin"} role
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export { getUsersCollection };

/**
 * Maps a persisted user record to safe public/session profile fields,
 * preserving whichever identifier format Better Auth stores (`id` / `_id`).
 */
export function sanitizeUserProfile(userDoc) {
  if (!userDoc || typeof userDoc !== "object") return null;

  const resolvedId = userDoc.id ?? (userDoc._id ? String(userDoc._id) : null);

  return {
    id: resolvedId,
    name: userDoc.name || "",
    email: userDoc.email || "",
    emailVerified: Boolean(userDoc.emailVerified),
    image: userDoc.image || null,
    phone: userDoc.phone || "",
    address: userDoc.address || "",
    role: userDoc.role || DEFAULT_USER_ROLE,
    createdAt: userDoc.createdAt || null,
    updatedAt: userDoc.updatedAt || null,
  };
}

/**
 * Validates and prepares mutable self-service profile fields plus `updatedAt`.
 */
export function buildUserProfileUpdate(payload = {}) {
  const clean = validateUserProfileInput(payload);
  return {
    ...clean,
    updatedAt: new Date(),
  };
}
