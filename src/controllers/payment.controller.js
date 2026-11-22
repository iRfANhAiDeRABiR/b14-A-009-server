import { paymentService } from "../services/payment.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP request handlers for customer payment endpoints.
 */
export function createPaymentController(service = paymentService) {
  return {
    createCheckoutSession: asyncHandler(async (req, res) => {
      const result = await service.createCheckoutSession({
        customerId: req.user.id,
        payload: req.body,
      });

      return sendSuccess(res, {
        statusCode: result.reused ? 200 : 201,
        message: "Stripe Checkout Session created successfully",
        data: result.data,
      });
    }),

    getSessionStatus: asyncHandler(async (req, res) => {
      const statusData = await service.getPaymentSessionStatus({
        customerId: req.user.id,
        sessionId: req.params.sessionId,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Payment session status retrieved successfully",
        data: statusData,
      });
    }),

    verifySessionStatus: asyncHandler(async (req, res) => {
      const statusData = await service.verifyAndSyncCheckoutSession({
        customerId: req.user.id,
        sessionId: req.params.sessionId,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: statusData.verified
          ? "Stripe payment verified and booking confirmed"
          : "Payment verification checked with Stripe",
        data: statusData,
      });
    }),
  };
}

export const paymentController = createPaymentController();
