import { adminPaymentService } from "../services/adminPayment.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP handlers for the Admin platform payment history (`/api/admin/payments`).
 */
export function createAdminPaymentController(service = adminPaymentService) {
  return {
    listPayments: asyncHandler(async (req, res) => {
      const result = await service.listPayments(req.query);

      return sendSuccess(res, {
        statusCode: 200,
        message: "Payment history retrieved successfully",
        data: result.payments,
        pagination: result.pagination,
        summary: result.summary,
      });
    }),
  };
}

export const adminPaymentController = createAdminPaymentController();
