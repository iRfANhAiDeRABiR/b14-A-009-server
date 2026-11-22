import { verifyJwtAccessToken } from "../config/jwks.js";
import { ALLOWED_USER_ROLES } from "../constants/roles.js";
import {
  buildUserLookupFilter,
  getUsersCollection,
  resolveUserIdentifier,
  SAFE_USER_PROJECTION,
} from "../models/user.model.js";
import { AuthErrors } from "../utils/authErrors.js";

function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== "string") {
    throw AuthErrors.missingToken();
  }

  const trimmed = authorizationHeader.trim();
  if (!trimmed) {
    throw AuthErrors.missingToken();
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    if (parts[0].toLowerCase() === "bearer") {
      throw AuthErrors.missingToken();
    }
    throw AuthErrors.invalidToken();
  }

  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    throw AuthErrors.invalidToken();
  }

  const token = parts[1].trim();
  if (!token) {
    throw AuthErrors.missingToken();
  }

  return token;
}

function isAccountDisabled(user) {
  if (!user || typeof user !== "object") return false;

  if (user.banned === true) {
    if (!user.banExpires) return true;
    const expiresAt = new Date(user.banExpires);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() > Date.now()) {
      return true;
    }
  }

  if (user.suspended === true || user.disabled === true || user.active === false) {
    return true;
  }

  if (typeof user.status === "string") {
    const normalized = user.status.trim().toLowerCase();
    if (["suspended", "banned", "disabled", "inactive"].includes(normalized)) {
      return true;
    }
  }

  return false;
}

/**
 * Factory creating the JWT authentication middleware with injectable collaborators for testing.
 * Always verifies cryptographic signatures against JWKS before loading the fresh user record
 * from MongoDB so stale JWT claims never retain revoked privileges.
 */
export function createVerifyTokenMiddleware({
  usersCollectionGetter = getUsersCollection,
  verifyAccessToken = verifyJwtAccessToken,
} = {}) {
  return async function verifyToken(req, _res, next) {
    try {
      // STEP 01: Read Bearer token from Authorization header
      const token = extractBearerToken(req.headers?.authorization);

      // STEP 02-03: Cryptographically verify signature, JWKS key, iss, aud, exp, sub & algorithm
      const verifiedPayload = await verifyAccessToken(token);

      // STEP 04: Load fresh user & current role directly from MongoDB `users`
      const usersCollection = await usersCollectionGetter();
      const user = await usersCollection.findOne(
        buildUserLookupFilter(verifiedPayload.sub),
        { projection: SAFE_USER_PROJECTION }
      );

      if (!user) {
        return next(AuthErrors.userNotFound());
      }

      if (isAccountDisabled(user)) {
        return next(AuthErrors.accountDisabled());
      }

      const currentRole = user.role;
      if (typeof currentRole !== "string" || !ALLOWED_USER_ROLES.includes(currentRole)) {
        return next(AuthErrors.invalidRole());
      }

      const actualUserId = resolveUserIdentifier(user);
      if (!actualUserId) {
        return next(AuthErrors.userNotFound());
      }

      // STEP 05: Attach verified token payload and fresh sanitized user context
      req.auth = verifiedPayload;
      req.user = {
        id: actualUserId,
        name: user.name || "",
        email: user.email || "",
        role: currentRole,
        image: user.image ?? null,
      };

      // STEP 06: Continue to downstream role guards or route controllers
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export const verifyToken = createVerifyTokenMiddleware();
