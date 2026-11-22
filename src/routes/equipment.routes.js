import { Router } from "express";
import {
  createEquipmentController,
  equipmentController,
} from "../controllers/equipment.controller.js";
import { verifyOwner } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

/**
 * Registers public, owner-protected, and authenticated detail equipment endpoints.
 * Specific paths (`/featured`, `/recent`, `/my`) are registered strictly before parameterized `/:id`.
 */
export function createEquipmentRouter({
  authMiddleware = verifyToken,
  ownerMiddleware = verifyOwner,
  controller = equipmentController,
} = {}) {
  const router = Router();

  // Specific non-parameterized routes first
  router.get("/featured", controller.getFeatured);
  router.get("/recent", controller.getRecent);
  router.get("/my", authMiddleware, ownerMiddleware, controller.listMine);

  // Collection root routes
  router.get("/", controller.listPublic);
  router.post("/", authMiddleware, ownerMiddleware, controller.create);

  // Parameterized item routes
  router.get("/:id", authMiddleware, controller.getById);
  router.patch("/:id", authMiddleware, ownerMiddleware, controller.updateMine);
  router.delete("/:id", authMiddleware, ownerMiddleware, controller.deleteMine);

  return router;
}

export { createEquipmentController };
export const equipmentRouter = createEquipmentRouter();
export default equipmentRouter;
