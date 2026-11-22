import { ALLOWED_USER_ROLES, USER_ROLES } from "../constants/roles.js";
import { AuthErrors } from "../utils/authErrors.js";

/**
 * Reusable role guard verifying the database-backed `req.user.role` attached by `verifyToken`.
 * Never inspects request bodies, query parameters, or unverified claims.
 */
export function requireRole(expectedRole, deniedMessage = "Access denied") {
  if (!ALLOWED_USER_ROLES.includes(expectedRole)) {
    throw new Error(`Invalid canonical role configuration: "${expectedRole}".`);
  }

  return function roleMiddleware(req, _res, next) {
    if (!req.user) {
      return next(AuthErrors.missingToken());
    }

    const userRole = req.user.role;
    if (typeof userRole !== "string" || !ALLOWED_USER_ROLES.includes(userRole)) {
      return next(AuthErrors.invalidRole());
    }

    if (userRole !== expectedRole) {
      return next(AuthErrors.forbiddenRole(deniedMessage));
    }

    return next();
  };
}

/**
 * Authorizes canonical database role `Customer` under the `verifyRenter` middleware contract.
 */
export const verifyRenter = requireRole(
  USER_ROLES.CUSTOMER,
  "Customer access required"
);

/**
 * Authorizes canonical database role `Owner`.
 */
export const verifyOwner = requireRole(USER_ROLES.OWNER, "Owner access required");

/**
 * Authorizes canonical database role `Admin`.
 */
export const verifyAdmin = requireRole(USER_ROLES.ADMIN, "Admin access required");

/**
 * Verifies resource ownership exclusively against authenticated `req.user.id`,
 * ignoring untrusted client-supplied identifiers (`req.body.userId`, `req.query.ownerId`, etc.).
 */
export function isResourceOwner(resourceOwnerId, req) {
  if (!req?.user?.id || resourceOwnerId === undefined || resourceOwnerId === null) {
    return false;
  }
  return String(resourceOwnerId).trim() === String(req.user.id).trim();
}
