import { ownerAnalyticsService } from "../services/ownerAnalytics.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP handlers for Owner dashboard analytics endpoints.
 */
export function createOwnerAnalyticsController(service = ownerAnalyticsService) {
  return {
    getAnalytics: asyncHandler(async (req, res) => {
      const analytics = await service.getOwnerAnalytics({
        ownerId: req.user?.id,
        query: req.query,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Owner dashboard analytics retrieved successfully",
        data: analytics,
      });
    }),
  };
}

export const ownerAnalyticsController = createOwnerAnalyticsController();
