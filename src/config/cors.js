import { env } from "./env.js";
import { ApiError } from "../utils/ApiError.js";

/**
 * Builds CORS middleware options enforcing explicit environment-configured
 * allowlists without combining wildcard origins and credentialed requests.
 */
export function createCorsOptions(allowedOrigins = env.corsOrigins) {
  const originSet = new Set(
    (Array.isArray(allowedOrigins) ? allowedOrigins : [])
      .map((item) => String(item || "").trim().replace(/\/+$/, ""))
      .filter((item) => Boolean(item) && item !== "*")
  );

  return {
    origin(requestOrigin, callback) {
      // Non-browser tools, curl, and server-side health checks omit Origin.
      if (!requestOrigin) {
        callback(null, true);
        return;
      }

      const normalizedRequestOrigin = String(requestOrigin)
        .trim()
        .replace(/\/+$/, "");

      if (originSet.has(normalizedRequestOrigin)) {
        callback(null, true);
        return;
      }

      callback(
        new ApiError("Origin not allowed by CORS policy.", 403, {
          code: "CORS_FORBIDDEN",
        })
      );
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Idempotency-Key",
    ],
    optionsSuccessStatus: 204,
  };
}

export const corsOptions = createCorsOptions();
