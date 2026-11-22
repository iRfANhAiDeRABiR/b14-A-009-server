import { resolveStripeWebhookSecret } from "../config/stripe.js";
import { ApiError } from "../utils/ApiError.js";
import { cleanString } from "./validationHelpers.js";

const STRIPE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;

/**
 * Verifies raw Buffer integrity, signing secret presence, and Stripe cryptographic signature.
 * Rejects unsigned payloads, pre-parsed JSON bodies, modified payloads, and stale replays.
 */
export function verifyConstructedStripeWebhookEvent({
  rawBody,
  signatureHeader,
  stripeClient,
  webhookSecretOverride,
}) {
  const signingSecret = resolveStripeWebhookSecret(webhookSecretOverride);

  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new ApiError("Invalid Stripe webhook signature", 400, {
      code: "INVALID_WEBHOOK_SIGNATURE",
    });
  }

  const cleanSignature =
    typeof signatureHeader === "string" ? signatureHeader.trim() : "";
  if (!cleanSignature) {
    throw new ApiError("Invalid Stripe webhook signature", 400, {
      code: "INVALID_WEBHOOK_SIGNATURE",
    });
  }

  try {
    return stripeClient.webhooks.constructEvent(
      rawBody,
      cleanSignature,
      signingSecret
    );
  } catch {
    throw new ApiError("Invalid Stripe webhook signature", 400, {
      code: "INVALID_WEBHOOK_SIGNATURE",
    });
  }
}

/**
 * Validates customer-facing GET /api/payments/session/:sessionId route parameter.
 */
export function validatePaymentSessionIdParam(rawSessionId) {
  const clean = cleanString(rawSessionId);
  if (!STRIPE_SESSION_ID_PATTERN.test(clean)) {
    throw new ApiError("Invalid payment session ID", 400, {
      code: "INVALID_SESSION_ID",
    });
  }
  return clean;
}
