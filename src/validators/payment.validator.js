import { ApiError } from "../utils/ApiError.js";
import { cleanString, isValidObjectId, toObjectId } from "./validationHelpers.js";

const RESTRICTED_CHECKOUT_FIELDS = Object.freeze([
  "totalAmount",
  "rentalPrice",
  "currency",
  "customerId",
  "ownerId",
  "equipmentId",
  "successUrl",
  "cancelUrl",
  "stripeSessionId",
  "paymentStatus",
  "status",
]);

/**
 * Strictly validates POST /api/payments/create-checkout-session payloads.
 * Accepts ONLY `bookingIntentId` and rejects client-controlled pricing, URLs, or ownership fields.
 */
export function validateCreateCheckoutSessionPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Invalid booking reservation", 400, {
      code: "INVALID_BOOKING_INTENT",
    });
  }

  const restricted = RESTRICTED_CHECKOUT_FIELDS.filter((key) =>
    Object.prototype.hasOwnProperty.call(payload, key)
  );
  if (restricted.length > 0) {
    throw new ApiError(
      `Restricted or server-controlled payment field(s) cannot be provided: ${restricted.join(", ")}.`,
      400,
      { code: "RESTRICTED_PAYMENT_FIELD" }
    );
  }

  const rawId = payload.bookingIntentId;
  if (typeof rawId !== "string" || !isValidObjectId(cleanString(rawId))) {
    throw new ApiError("Invalid booking reservation", 400, {
      code: "INVALID_BOOKING_INTENT",
    });
  }

  return {
    bookingIntentId: toObjectId(cleanString(rawId), "bookingIntentId"),
  };
}
