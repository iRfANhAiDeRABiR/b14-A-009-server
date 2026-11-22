import { Router } from "express";
import {
  adminEquipmentController,
  createAdminEquipmentController,
} from "../controllers/adminEquipment.controller.js";
import { verifyAdmin } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

/**
 * Registers Admin equipment moderation, inspection, update, and deletion routes (`/api/admin/equipment`).
 * Specific approval/rejection routes precede generic `PATCH /:id` safely.
 */
export function createAdminEquipmentRouter({
  authMiddleware = verifyToken,
  adminMiddleware = verifyAdmin,
  controller = adminEquipmentController,
} = {}) {
  const router = Router();

  router.use(authMiddleware, adminMiddleware);

  router.get("/", controller.listAll);
  router.get("/:id", controller.getDetails);
  router.patch("/:id/approve", controller.approve);
  router.patch("/:id/reject", controller.reject);
  router.patch("/:id", controller.update);
  router.delete("/:id", controller.remove);

  return router;
}

export { createAdminEquipmentController };
export const adminEquipmentRouter = createAdminEquipmentRouter();
export default adminEquipmentRouter;
