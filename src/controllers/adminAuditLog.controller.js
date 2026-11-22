import { auditLogService } from "../services/auditLog.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP handlers for Admin platform event / audit logs (`/api/admin/logs`).
 */
export function createAdminAuditLogController(service = auditLogService) {
  return {
    listLogs: asyncHandler(async (req, res) => {
      const result = await service.listLogs(req.query);

      return sendSuccess(res, {
        statusCode: 200,
        message: "Event logs retrieved successfully",
        data: result.logs,
        pagination: result.pagination,
        summary: result.summary,
      });
    }),
  };
}

export const adminAuditLogController = createAdminAuditLogController();
