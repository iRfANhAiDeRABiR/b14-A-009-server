import { Router } from "express";
import {
  createUploadController,
  uploadController,
} from "../controllers/upload.controller.js";
import { uploadEquipmentImageMiddleware } from "../middleware/upload.middleware.js";
import { verifyOwner } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

export function createUploadRouter({
  authMiddleware = verifyToken,
  ownerMiddleware = verifyOwner,
  uploadMiddleware = uploadEquipmentImageMiddleware,
  controller = uploadController,
} = {}) {
  const router = Router();

  router.post(
    "/equipment-image",
    authMiddleware,
    ownerMiddleware,
    uploadMiddleware,
    controller.uploadEquipmentImage
  );

  return router;
}

export { createUploadController };
export const uploadRouter = createUploadRouter();
export default uploadRouter;
