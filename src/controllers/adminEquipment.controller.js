import { adminEquipmentService } from "../services/adminEquipment.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP handlers for Admin equipment moderation, editing, and archival/deletion.
 */
export function createAdminEquipmentController(service = adminEquipmentService) {
  return {
    listAll: asyncHandler(async (req, res) => {
      const result = await service.listAdminEquipment({
        query: req.query,
      });

      return res.status(200).json({
        success: true,
        message: "Admin equipment retrieved successfully",
        data: result.items,
        pagination: result.pagination,
        summary: result.summary,
      });
    }),

    getDetails: asyncHandler(async (req, res) => {
      const item = await service.getAdminEquipmentDetails({
        equipmentId: req.params.id,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Equipment details retrieved successfully",
        data: item,
      });
    }),

    approve: asyncHandler(async (req, res) => {
      const result = await service.approveEquipment({
        equipmentId: req.params.id,
        adminId: req.user.id,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: result.idempotent
          ? "Equipment is already approved"
          : "Equipment approved successfully",
        data: result.item,
      });
    }),

    reject: asyncHandler(async (req, res) => {
      const result = await service.rejectEquipment({
        equipmentId: req.params.id,
        adminId: req.user.id,
        payload: req.body,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: result.idempotent
          ? "Equipment is already rejected with this reason"
          : "Equipment rejected successfully",
        data: result.item,
      });
    }),

    update: asyncHandler(async (req, res) => {
      const updated = await service.updateAdminEquipment({
        equipmentId: req.params.id,
        payload: req.body,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Equipment updated successfully",
        data: updated,
      });
    }),

    remove: asyncHandler(async (req, res) => {
      const result = await service.deleteAdminEquipment({
        equipmentId: req.params.id,
        adminId: req.user.id,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: result.message,
        data: {
          equipmentId: result.equipmentId,
          deleted: result.deleted,
          archived: result.archived,
        },
      });
    }),
  };
}

export const adminEquipmentController = createAdminEquipmentController();
