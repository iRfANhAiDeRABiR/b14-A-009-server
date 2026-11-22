import { ObjectId } from "mongodb";
import { DEFAULT_USER_ROLE } from "../constants/roles.js";
import { getUsersCollection } from "./collections.js";
import { validateUserProfileInput } from "../validators/userValidator.js";

/**
 * Explicit safe database projection omitting sensitive credentials or private tokens.
 */
export const SAFE_USER_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  email: 1,
  emailVerified: 1,
  image: 1,
  phone: 1,
  address: 1,
  role: 1,
  banned: 1,
  banExpires: 1,
  suspended: 1,
  disabled: 1,
  active: 1,
  status: 1,
  suspensionReason: 1,
  statusUpdatedAt: 1,
  isDeleted: 1,
  createdAt: 1,
  updatedAt: 1,
});

/**
 * Builds a query filter matching Better Auth user records whether keyed by
 * MongoDB ObjectId (`_id`) or string identifiers (`_id` / `id`).
 */
export function buildUserLookupFilter(identifier) {
  const cleanId = String(identifier || "").trim();
  const candidates = [{ _id: cleanId }, { id: cleanId }];
  if (ObjectId.isValid(cleanId) && new ObjectId(cleanId).toString() === cleanId) {
    candidates.unshift({ _id: new ObjectId(cleanId) });
  }
  return { $or: candidates };
}

export function resolveUserIdentifier(userDoc) {
  if (typeof userDoc?.id === "string" && userDoc.id.trim().length > 0) {
    return userDoc.id.trim();
  }
  if (userDoc?._id !== undefined && userDoc?._id !== null) {
    return String(userDoc._id);
  }
  return null;
}

function resolveAccountStatus(userDoc) {
  if (userDoc?.isDeleted === true) return "Deleted";
  if (userDoc?.banned === true) return "Banned";
  if (userDoc?.suspended === true) return "Suspended";
  if (userDoc?.disabled === true) return "Disabled";
  if (userDoc?.active === false) return "Inactive";
  if (typeof userDoc?.status === "string" && userDoc.status.trim()) {
    return userDoc.status.trim();
  }
  return "Active";
}

export { getUsersCollection };

/**
 * Maps a persisted user record to safe public/session profile fields,
 * preserving whichever identifier format Better Auth stores (`id` / `_id`).
 */
export function sanitizeUserProfile(userDoc) {
  if (!userDoc || typeof userDoc !== "object") return null;

  return {
    id: resolveUserIdentifier(userDoc),
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
 * Maps a user record to safe administrative fields (including optional account status).
 */
export function sanitizeAdminUserProfile(userDoc) {
  const base = sanitizeUserProfile(userDoc);
  if (!base) return null;

  const accountStatus = resolveAccountStatus(userDoc);
  return {
    ...base,
    accountStatus,
    ...(userDoc.suspensionReason
      ? { suspensionReason: String(userDoc.suspensionReason) }
      : {}),
    ...(userDoc.statusUpdatedAt ? { statusUpdatedAt: userDoc.statusUpdatedAt } : {}),
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
