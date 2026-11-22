import { adminInquiryService } from "../services/adminInquiry.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP handlers for Admin support inquiry endpoints (`/api/admin/inquiries`).
 */
export function createAdminInquiryController(service = adminInquiryService) {
  return {
    listInquiries: asyncHandler(async (req, res) => {
      const result = await service.listInquiries(req.query);

      return sendSuccess(res, {
        statusCode: 200,
        message: "Support inquiries retrieved successfully",
        data: result.items,
        pagination: result.pagination,
        summary: result.summary,
      });
    }),

    updateStatus: asyncHandler(async (req, res) => {
      const updated = await service.updateInquiryStatus({
        inquiryId: req.params.id,
        body: req.body,
        adminUser: req.user,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: `Inquiry marked as ${updated.status}`,
        data: updated,
      });
    }),

    removeInquiry: asyncHandler(async (req, res) => {
      const result = await service.deleteInquiry({
        inquiryId: req.params.id,
        adminUser: req.user,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Support inquiry deleted successfully",
        data: result,
      });
    }),
  };
}

export const adminInquiryController = createAdminInquiryController();
