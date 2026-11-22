import { ApiError } from "./ApiError.js";

/**
 * Standardized authentication and authorization error builders that omit raw tokens,
 * database internals, and stack traces from HTTP responses.
 */
export function createAuthError(message, statusCode, code) {
  const err = new ApiError(message, statusCode, {
    code,
    isOperational: true,
  });
  err.omitErrorPayload = true;
  return err;
}

export const AuthErrors = Object.freeze({
  missingToken: () => createAuthError("Authentication required", 401, "AUTH_REQUIRED"),
  invalidToken: () =>
    createAuthError("Invalid or expired access token", 401, "INVALID_TOKEN"),
  expiredToken: () =>
    createAuthError(
      "Your session has expired. Please log in again.",
      401,
      "TOKEN_EXPIRED"
    ),
  userNotFound: () =>
    createAuthError("Authenticated user not found", 401, "USER_NOT_FOUND"),
  invalidRole: () =>
    createAuthError(
      "Your account does not have a valid role",
      403,
      "INVALID_USER_ROLE"
    ),
  accountDisabled: () =>
    createAuthError(
      "Your account has been disabled or suspended",
      403,
      "ACCOUNT_DISABLED"
    ),
  jwksUnavailable: () =>
    createAuthError(
      "Authentication verification service is unavailable",
      503,
      "JWKS_UNAVAILABLE"
    ),
  forbiddenRole: (message) => createAuthError(message, 403, "FORBIDDEN"),
});
