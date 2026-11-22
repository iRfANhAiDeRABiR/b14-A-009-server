import { imageUploadService } from "../services/imageUpload.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export function createUploadController(service = imageUploadService) {
  return {
    uploadEquipmentImage: asyncHandler(async (req, res) => {
      const uploaded = await service.uploadEquipmentImage(req.file);
      return sendSuccess(res, {
        statusCode: 200,
        message: "Image uploaded successfully",
        data: uploaded,
      });
    }),
  };
}

export const uploadController = createUploadController();
