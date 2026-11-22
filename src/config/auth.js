import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { jwt } from "better-auth/plugins";

import { DEFAULT_USER_ROLE } from "../constants/roles.js";
import {
  requireAuthEnv,
  validateSignupName,
  validateSignupPassword,
} from "../utils/authHelpers.js";
import { cleanString, isValidHttpUrl } from "../validators/validationHelpers.js";
import { getClient, getDB } from "./db.js";
import { env } from "./env.js";

let authInstance = null;
let cachedSummary = null;

function buildBeforeAuthHook() {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/sign-up/email") {
      return;
    }

    const body = ctx.body || {};
    const nameCheck = validateSignupName(body.name);
    if (!nameCheck.valid) {
      throw APIError.from("BAD_REQUEST", {
        message: nameCheck.message,
        code: "INVALID_NAME",
      });
    }

    const passwordCheck = validateSignupPassword(body.password);
    if (!passwordCheck.valid) {
      throw APIError.from("BAD_REQUEST", {
        message: passwordCheck.message,
        code: "WEAK_PASSWORD",
      });
    }

    const image = cleanString(body.image);
    if (image && !isValidHttpUrl(image)) {
      throw APIError.from("BAD_REQUEST", {
        message: "Profile photo must be a valid HTTP or HTTPS URL.",
        code: "INVALID_IMAGE_URL",
      });
    }
  });
}

/**
 * Builds the Better Auth configuration shared across Express integration and verification.
 */
export function buildBetterAuthOptions({
  db = null,
  client = null,
  databaseOverride = null,
} = {}) {
  const authEnv = requireAuthEnv();
  const database =
    databaseOverride ||
    mongodbAdapter(db, {
      client,
      usePlural: true,
      transaction: env.mongodbTransactions,
    });

  const socialProviders = authEnv.google.enabled
    ? {
        google: {
          clientId: authEnv.google.clientId,
          clientSecret: authEnv.google.clientSecret,
        },
      }
    : undefined;

  return {
    authEnv,
    options: {
      appName: "GearNest",
      baseURL: authEnv.baseUrl,
      basePath: "/api/auth",
      secret: authEnv.secret,
      trustedOrigins: authEnv.trustedOrigins,
      database,

      emailAndPassword: {
        enabled: true,
        minPasswordLength: 6,
        maxPasswordLength: 128,
        requireEmailVerification: false,
        autoSignIn: true,
      },

      ...(socialProviders ? { socialProviders } : {}),

      user: {
        additionalFields: {
          role: {
            type: "string",
            required: true,
            defaultValue: DEFAULT_USER_ROLE,
            input: false,
          },
          phone: {
            type: "string",
            required: false,
            defaultValue: "",
            input: true,
          },
          address: {
            type: "string",
            required: false,
            defaultValue: "",
            input: true,
          },
        },
      },

      session: {
        expiresIn: 60 * 60 * 24 * 7,
        updateAge: 60 * 60 * 24,
      },

      rateLimit: {
        enabled: authEnv.rateLimitEnabled,
        window: 60,
        max: 120,
        customRules: {
          "/sign-in/email": { window: 60, max: 20 },
          "/sign-up/email": { window: 60, max: 20 },
          "/sign-in/social": { window: 60, max: 25 },
        },
      },

      advanced: {
        ipAddress: {
          ipAddressHeaders: ["x-gearnest-client-ip"],
        },
        useSecureCookies: authEnv.isHttps && env.isProduction,
        defaultCookieAttributes: authEnv.defaultCookieAttributes,
      },

      hooks: {
        before: buildBeforeAuthHook(),
      },

      databaseHooks: {
        user: {
          create: {
            before: async (user) => ({
              data: {
                ...user,
                role: DEFAULT_USER_ROLE,
              },
            }),
          },
        },
      },

      plugins: [
        jwt({
          jwt: {
            issuer: authEnv.baseUrl,
            audience: authEnv.baseUrl,
            expirationTime: "15m",
            definePayload: ({ user }) => ({
              id: user.id,
              sub: user.id,
              email: user.email,
              name: user.name,
              role: user.role || DEFAULT_USER_ROLE,
            }),
          },
        }),
      ],
    },
  };
}

/**
 * Creates or returns the singleton Better Auth instance bound to Commit 02's
 * singleton MongoDB connection and shared `users` collection.
 */
export function initAuth({ db = null, client = null, databaseOverride = null } = {}) {
  if (authInstance) {
    return authInstance;
  }

  const resolvedDb = databaseOverride ? null : db || getDB();
  const resolvedClient = databaseOverride ? null : client || getClient();
  const { authEnv, options } = buildBetterAuthOptions({
    db: resolvedDb,
    client: resolvedClient,
    databaseOverride,
  });

  authInstance = betterAuth(options);

  cachedSummary = Object.freeze({
    baseUrl: authEnv.baseUrl,
    basePath: "/api/auth",
    googleOAuthEnabled: authEnv.google.enabled,
    googleCallbackUrl: `${authEnv.baseUrl}/api/auth/callback/google`,
    rateLimitEnabled: authEnv.rateLimitEnabled,
  });

  return authInstance;
}

export function getAuth() {
  return initAuth();
}

export function getAuthStatusSummary() {
  return cachedSummary;
}

export function resetAuth() {
  authInstance = null;
  cachedSummary = null;
}
