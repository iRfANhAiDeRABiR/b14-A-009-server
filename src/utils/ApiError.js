/**
 * Operational API error carrying explicit HTTP status and optional metadata.
 */
export class ApiError extends Error {
  constructor(
    message,
    statusCode = 500,
    { code = "API_ERROR", details = null, isOperational = true } = {}
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.status = statusCode >= 400 && statusCode < 500 ? "fail" : "error";
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;

    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
