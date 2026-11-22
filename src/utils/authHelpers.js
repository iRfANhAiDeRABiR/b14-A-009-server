import { env } from "../config/env.js";
import { cleanString, isValidHttpUrl } from "../validators/validationHelpers.js";

const PLACEHOLDER_HINTS = ["your_", "your-", "change-me", "placeholder", "example"];

function isConfiguredValue(raw) {
  const clean = cleanString(raw);
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (lower.startsWith("<") && lower.endsWith(">")) return false;
  return !PLACEHOLDER_HINTS.some((hint) => lower.includes(hint));
}

export function validateSignupName(rawName) {
  const clean = cleanString(rawName);
  if (!clean) {
    return { valid: false, message: "Full name is required." };
  }
  if (clean.length < 2 || clean.length > 80) {
    return {
      valid: false,
      message: "Full name must be between 2 and 80 characters.",
    };
  }
  return { valid: true, message: null, value: clean };
}

/**
 * Enforces GearNest assignment password rules on signup:
 * minimum 6 characters, at least one uppercase letter, and at least one lowercase letter.
 */
export function validateSignupPassword(rawPassword) {
  if (typeof rawPassword !== "string" || rawPassword.length === 0) {
    return { valid: false, message: "Password is required." };
  }
  if (rawPassword.length < 6) {
    return {
      valid: false,
      message: "Password must be at least 6 characters long.",
    };
  }
  if (rawPassword.length > 128) {
    return {
      valid: false,
      message: "Password cannot exceed 128 characters.",
    };
  }
  if (!/[A-Z]/.test(rawPassword)) {
    return {
      valid: false,
      message: "Password must include at least one uppercase letter.",
    };
  }
  if (!/[a-z]/.test(rawPassword)) {
    return {
      valid: false,
      message: "Password must include at least one lowercase letter.",
    };
  }
  return { valid: true, message: null };
}

export function getGoogleOAuthConfig() {
  const clientId = cleanString(process.env.GOOGLE_CLIENT_ID);
  const clientSecret = cleanString(process.env.GOOGLE_CLIENT_SECRET);
  const hasId = isConfiguredValue(clientId);
  const hasSecret = isConfiguredValue(clientSecret);

  if (hasId && hasSecret) {
    return {
      enabled: true,
      clientId,
      clientSecret,
    };
  }

  if (hasId !== hasSecret) {
    console.warn(
      "[GearNest Auth] Google OAuth disabled: both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set."
    );
  }

  return {
    enabled: false,
    clientId: "",
    clientSecret: "",
  };
}

export function resolveTrustedOrigins(baseUrl) {
  const candidates = [...env.corsOrigins];
  if (env.clientUrl) candidates.push(env.clientUrl);
  if (baseUrl) candidates.push(baseUrl);

  const unique = [];
  for (const raw of candidates) {
    const clean = cleanString(raw).replace(/\/+$/, "");
    if (!clean || clean === "*" || !isValidHttpUrl(clean)) continue;
    const normalized = new URL(clean).origin;
    if (!unique.includes(normalized)) {
      unique.push(normalized);
    }
  }
  return unique;
}

/**
 * Computes cookie attributes suited to the active deployment architecture.
 * Uses SameSite=None only when HTTPS frontend and backend live on distinct hostnames.
 */
export function getDefaultCookieAttributes({ isProduction, baseUrl, trustedOrigins = [] }) {
  let isHttps = false;
  let serverHost = "";
  try {
    const parsedServer = new URL(baseUrl);
    isHttps = parsedServer.protocol === "https:";
    serverHost = parsedServer.hostname.toLowerCase();
  } catch {
    isHttps = false;
  }

  const isCrossSiteProduction =
    isProduction &&
    isHttps &&
    trustedOrigins.some((origin) => {
      try {
        const parsedClient = new URL(origin);
        return (
          parsedClient.protocol === "https:" &&
          parsedClient.hostname.toLowerCase() !== serverHost
        );
      } catch {
        return false;
      }
    });

  return {
    httpOnly: true,
    secure: isHttps && isProduction,
    sameSite: isCrossSiteProduction ? "none" : "lax",
  };
}

export function resolveAuthBaseUrl() {
  const rawBaseUrl = cleanString(process.env.BETTER_AUTH_URL || env.betterAuthUrl);
  const fallbackBaseUrl = !env.isProduction ? `http://localhost:${env.port}` : "";
  const candidateBaseUrl = rawBaseUrl || fallbackBaseUrl;

  if (!candidateBaseUrl) {
    throw new Error(
      "Missing required BETTER_AUTH_URL environment variable for production."
    );
  }
  if (!isValidHttpUrl(candidateBaseUrl)) {
    throw new Error(
      "Invalid BETTER_AUTH_URL. Expected a valid http:// or https:// URL."
    );
  }

  return new URL(candidateBaseUrl).origin;
}

/**
 * Resolves JWKS URL, issuer, and audience matching Better Auth's JWT plugin config.
 */
export function getAuthJwtVerificationConfig() {
  const baseUrl = resolveAuthBaseUrl();

  const rawJwksUrl = cleanString(process.env.BETTER_AUTH_JWKS_URL);
  if (rawJwksUrl && !isValidHttpUrl(rawJwksUrl)) {
    throw new Error(
      "Invalid BETTER_AUTH_JWKS_URL. Expected a valid http:// or https:// URL."
    );
  }

  const jwksUrl = rawJwksUrl || `${baseUrl}/api/auth/jwks`;
  const issuer = cleanString(process.env.BETTER_AUTH_ISSUER) || baseUrl;
  const audience = cleanString(process.env.BETTER_AUTH_AUDIENCE) || baseUrl;

  return {
    baseUrl,
    jwksUrl,
    issuer,
    audience,
  };
}

/**
 * Validates Better Auth environment variables without logging or exposing secrets.
 */
export function requireAuthEnv() {
  const secret = cleanString(process.env.BETTER_AUTH_SECRET);
  if (!secret || !isConfiguredValue(secret)) {
    throw new Error(
      "Missing or placeholder BETTER_AUTH_SECRET environment variable."
    );
  }

  const minLength = env.isProduction ? 32 : 16;
  if (secret.length < minLength) {
    throw new Error(
      `BETTER_AUTH_SECRET must be at least ${minLength} characters long in ${env.nodeEnv} mode.`
    );
  }

  const { baseUrl, jwksUrl, issuer, audience } = getAuthJwtVerificationConfig();
  const trustedOrigins = resolveTrustedOrigins(baseUrl);
  const defaultCookieAttributes = getDefaultCookieAttributes({
    isProduction: env.isProduction,
    baseUrl,
    trustedOrigins,
  });

  const rateLimitFlag = cleanString(process.env.AUTH_RATE_LIMIT).toLowerCase();
  const rateLimitEnabled = rateLimitFlag ? rateLimitFlag !== "false" : !env.isTest;

  return {
    secret,
    baseUrl,
    jwksUrl,
    issuer,
    audience,
    trustedOrigins,
    defaultCookieAttributes,
    isHttps: baseUrl.startsWith("https://"),
    rateLimitEnabled,
    google: getGoogleOAuthConfig(),
  };
}
