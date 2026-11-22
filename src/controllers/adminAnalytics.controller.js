import { adminAnalyticsService } from "../services/adminAnalytics.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP handlers for Admin dashboard analytics endpoints.
 */
export function createAdminAnalyticsController(service = adminAnalyticsService) {
  return {
    getAnalytics: asyncHandler(async (req, res) => {
      const analytics = await service.getAdminAnalytics(req.query);

      return sendSuccess(res, {
        statusCode: 200,
        message: "Admin platform analytics retrieved successfully",
        data: analytics,
      });
    }),
  };
}

export const adminAnalyticsController = createAdminAnalyticsController();
