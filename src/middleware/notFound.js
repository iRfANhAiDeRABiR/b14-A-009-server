import { ApiError } from "../utils/ApiError.js";

/**
 * Forwards unmatched requests into the centralized error pipeline.
 */
export function notFound(_req, _res, next) {
  next(new ApiError("Route not found", 404, { code: "NOT_FOUND" }));
}
