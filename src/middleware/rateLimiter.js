import { ApiError } from "../utils/ApiError.js";

function resolveClientIp(req) {
  const raw = req?.ip || req?.socket?.remoteAddress || "unknown";
  return String(raw).trim() || "unknown";
}

/**
 * Lightweight sliding-window IP rate limiter with bounded bucket cleanup
 * returning standard RateLimit/Retry-After headers and HTTP 429 on abuse.
 */
export function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 100,
  keyPrefix = "global",
  message = "Too many requests. Please wait and try again later.",
  skip = null,
} = {}) {
  const hits = new Map();
  let opsSinceSweep = 0;

  return function rateLimiterMiddleware(req, res, next) {
    if (typeof skip === "function" && skip(req)) {
      return next();
    }

    const now = Date.now();
    opsSinceSweep += 1;
    if (opsSinceSweep >= 250 || hits.size > 5000) {
      opsSinceSweep = 0;
      for (const [entryKey, timestamps] of hits.entries()) {
        const fresh = timestamps.filter((ts) => now - ts < windowMs);
        if (fresh.length === 0) {
          hits.delete(entryKey);
        } else {
          hits.set(entryKey, fresh);
        }
      }
    }

    const clientKey = `${keyPrefix}:${resolveClientIp(req)}`;
    const recentTimestamps = (hits.get(clientKey) || []).filter(
      (ts) => now - ts < windowMs
    );

    if (recentTimestamps.length >= max) {
      const oldestActive = recentTimestamps[0] || now;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldestActive + windowMs - now) / 1000)
      );

      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.setHeader("RateLimit-Limit", String(max));
      res.setHeader("RateLimit-Remaining", "0");
      res.setHeader("RateLimit-Reset", String(retryAfterSeconds));

      return next(
        new ApiError(message, 429, {
          code: "RATE_LIMIT_EXCEEDED",
          details: { retryAfterSeconds },
        })
      );
    }

    recentTimestamps.push(now);
    hits.set(clientKey, recentTimestamps);

    const remaining = Math.max(0, max - recentTimestamps.length);
    const resetSeconds = Math.max(1, Math.ceil(windowMs / 1000));
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    return next();
  };
}

export const contactRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: "contact",
  message: "Too many contact messages submitted from this IP. Please try again later.",
  skip: () => process.env.NODE_ENV === "test",
});

export const apiRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyPrefix: "api",
  message: "Too many API requests from this IP. Please slow down and try again shortly.",
  skip: (req) =>
    process.env.NODE_ENV === "test" ||
    req.originalUrl?.startsWith("/api/payments/webhook") ||
    req.originalUrl?.startsWith("/api/health"),
});
