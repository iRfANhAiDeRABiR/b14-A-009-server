import { equipmentService } from "../services/equipment.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export function createEquipmentController(service = equipmentService) {
  return {
    getFeatured: asyncHandler(async (req, res) => {
      const items = await service.getFeaturedEquipment({ limit: req.query.limit });
      return sendSuccess(res, {
        statusCode: 200,
        message: "Featured equipment retrieved successfully",
        data: items,
      });
    }),

    getRecent: asyncHandler(async (req, res) => {
      const items = await service.getRecentEquipment({ limit: req.query.limit });
      return sendSuccess(res, {
        statusCode: 200,
        message: "Recently added equipment retrieved successfully",
        data: items,
      });
    }),

    listPublic: asyncHandler(async (req, res) => {
      const result = await service.listPublicApprovedEquipment(req.query);
      return sendSuccess(res, {
        statusCode: 200,
        message:
          result.items.length === 0
            ? "No matching equipment found"
            : "Equipment retrieved successfully",
        data: result.items,
        pagination: result.pagination,
      });
    }),

    listMine: asyncHandler(async (req, res) => {
      const result = await service.listOwnerEquipment({
        ownerId: req.user.id,
        query: req.query,
      });
      return res.status(200).json({
        success: true,
        message: "Owner equipment retrieved successfully",
        data: result.items,
        pagination: result.pagination,
        summary: result.summary,
      });
    }),

    create: asyncHandler(async (req, res) => {
      const created = await service.createEquipment({
        ownerId: req.user.id,
        payload: req.body,
      });
      return sendSuccess(res, {
        statusCode: 201,
        message: "Equipment submitted successfully and is pending admin approval",
        data: created,
      });
    }),

    getById: asyncHandler(async (req, res) => {
      const item = await service.getEquipmentDetails({
        equipmentId: req.params.id,
        user: req.user,
      });
      return sendSuccess(res, {
        statusCode: 200,
        message: "Equipment details retrieved successfully",
        data: item,
      });
    }),

    updateMine: asyncHandler(async (req, res) => {
      const updated = await service.updateOwnerEquipment({
        equipmentId: req.params.id,
        ownerId: req.user.id,
        payload: req.body,
      });
      return sendSuccess(res, {
        statusCode: 200,
        message: "Equipment updated successfully",
        data: updated,
      });
    }),

    deleteMine: asyncHandler(async (req, res) => {
      await service.deleteOwnerEquipment({
        equipmentId: req.params.id,
        ownerId: req.user.id,
      });
      return res.status(200).json({
        success: true,
        message: "Equipment deleted successfully",
      });
    }),
  };
}

export const equipmentController = createEquipmentController();
