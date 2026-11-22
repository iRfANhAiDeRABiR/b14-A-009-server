import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

import { getAuthJwtVerificationConfig } from "../utils/authHelpers.js";
import { AuthErrors } from "../utils/authErrors.js";

// Permit asymmetric JWS algorithms supported by Better Auth JWT plugin only.
// Explicitly excludes "none" and symmetric algorithms such as HS256.
export const ALLOWED_JWT_ALGORITHMS = Object.freeze(["EdDSA", "ES256", "RS256"]);

const jwksResolverCache = new Map();

/**
 * Returns a cached `jose` remote JWK set resolver for the configured JWKS URL.
 * Supports automatic key-rotation refresh when an unseen `kid` arrives without
 * fetching keys redundantly on every API call.
 */
export function getRemoteJWKSet(jwksUrl = getAuthJwtVerificationConfig().jwksUrl) {
  let cached = jwksResolverCache.get(jwksUrl);
  if (!cached) {
    cached = createRemoteJWKSet(new URL(jwksUrl), {
      cooldownDuration: 30000,
      cacheMaxAge: 600000,
      timeoutDuration: 5000,
    });
    jwksResolverCache.set(jwksUrl, cached);
  }
  return cached;
}

export function clearRemoteJWKSetCache() {
  jwksResolverCache.clear();
}

function mapJwtVerificationError(error) {
  if (error instanceof joseErrors.JWTExpired) {
    return AuthErrors.expiredToken();
  }

  if (
    error instanceof joseErrors.JOSEAlgNotAllowed ||
    error instanceof joseErrors.JWTInvalid ||
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JWTClaimValidationFailed ||
    error instanceof joseErrors.JWKSNoMatchingKey
  ) {
    return AuthErrors.invalidToken();
  }

  // Timeout, DNS/network errors, HTTP 5xx, invalid JSON, or ambiguous JWKS state:
  // Always fail closed and never treat an unverified token as valid.
  return AuthErrors.jwksUnavailable();
}

/**
 * Cryptographically verifies a compact Better Auth JWT against remote JWKS public keys,
 * enforcing issuer, audience, expiration, subject, and allowed signing algorithms.
 */
export async function verifyJwtAccessToken(
  token,
  { jwksUrl, issuer, audience, keyResolver } = {}
) {
  const defaults = getAuthJwtVerificationConfig();
  const targetJwksUrl = jwksUrl || defaults.jwksUrl;
  const targetIssuer = issuer || defaults.issuer;
  const targetAudience = audience || defaults.audience;
  const resolver = keyResolver || getRemoteJWKSet(targetJwksUrl);

  try {
    const { payload } = await jwtVerify(token, resolver, {
      algorithms: [...ALLOWED_JWT_ALGORITHMS],
      issuer: targetIssuer,
      audience: targetAudience,
      requiredClaims: ["sub", "exp"],
    });

    if (typeof payload?.sub !== "string" || payload.sub.trim().length === 0) {
      throw AuthErrors.invalidToken();
    }

    return payload;
  } catch (error) {
    if (error?.name === "ApiError") {
      throw error;
    }
    throw mapJwtVerificationError(error);
  }
}
