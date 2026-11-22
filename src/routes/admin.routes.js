import { Router } from "express";
import {
  adminUserController,
  createAdminUserController,
} from "../controllers/adminUser.controller.js";
import { verifyAdmin } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

export function createAdminRouter({
  authMiddleware = verifyToken,
  adminMiddleware = verifyAdmin,
  controller = adminUserController,
} = {}) {
  const router = Router();

  router.get("/users", authMiddleware, adminMiddleware, controller.getUsers);
  router.get("/users/:id", authMiddleware, adminMiddleware, controller.getUserById);
  router.patch(
    "/users/:id/role",
    authMiddleware,
    adminMiddleware,
    controller.updateUserRole
  );

  return router;
}

export { createAdminUserController };
export const adminRouter = createAdminRouter();
export default adminRouter;
