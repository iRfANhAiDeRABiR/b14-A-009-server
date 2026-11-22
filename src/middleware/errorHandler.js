import { env } from "../config/env.js";

/**
 * Normalizes known transport/parser failures (such as malformed JSON payloads
 * or oversized request bodies) into consistent API error attributes.
 */
function normalizeError(err) {
  if (
    err instanceof SyntaxError &&
    (err.status === 400 || err.statusCode === 400) &&
    "body" in err
  ) {
    return {
      statusCode: 400,
      message: "Malformed JSON request body",
      code: "INVALID_JSON",
      details: null,
      isOperational: true,
    };
  }

  if (err?.type === "entity.too.large" || err?.status === 413 || err?.statusCode === 413) {
    return {
      statusCode: 413,
      message: "Request payload exceeds the maximum allowed size",
      code: "PAYLOAD_TOO_LARGE",
      details: null,
      isOperational: true,
    };
  }

  const statusCode =
    Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
        ? err.status
        : 500;

  return {
    statusCode,
    message:
      typeof err?.message === "string" && err.message.trim()
        ? err.message.trim()
        : "Internal server error",
    code: err?.code || "INTERNAL_ERROR",
    details: err?.details ?? null,
    isOperational: Boolean(err?.isOperational),
  };
}

/**
 * Central Express error-handling middleware producing consistent,
 * production-safe JSON responses without leaking credentials or stack traces.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const normalized = normalizeError(err);

  if (normalized.statusCode >= 500) {
    console.error(`[API Error] ${req.method} ${req.originalUrl}:`, err);
  }

  const safeMessage =
    env.isProduction && !normalized.isOperational && normalized.statusCode >= 500
      ? "Internal server error"
      : normalized.message;

  let errorPayload = null;
  if (!env.isProduction) {
    if (normalized.statusCode >= 500 && err?.stack) {
      errorPayload = {
        code: normalized.code,
        stack: err.stack,
      };
    } else if (normalized.details !== null) {
      errorPayload = normalized.details;
    } else if (normalized.statusCode !== 404) {
      errorPayload = { code: normalized.code };
    }
  }

  res.status(normalized.statusCode).json({
    success: false,
    message: safeMessage,
    error: errorPayload,
  });
}
