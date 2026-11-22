import { stripeWebhookService } from "../services/stripeWebhook.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory handling verified Stripe webhook requests received with raw binary Buffers.
 */
export function createPaymentWebhookController(service = stripeWebhookService) {
  return {
    handleWebhook: asyncHandler(async (req, res) => {
      const result = await service.processStripeWebhook({
        rawBody: req.body,
        signatureHeader: req.headers?.["stripe-signature"],
      });

      return res.status(200).json({
        success: true,
        received: true,
        message: result.message,
      });
    }),
  };
}

export const paymentWebhookController = createPaymentWebhookController();
export const paymentWebhookHandler = paymentWebhookController.handleWebhook;
