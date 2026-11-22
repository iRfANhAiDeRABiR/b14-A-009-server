import { Router } from "express";
import {
  adminRentalController,
  createAdminRentalController,
} from "../controllers/adminRental.controller.js";
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
  rentalController = adminRentalController,
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

  router.get(
    "/rentals",
    authMiddleware,
    adminMiddleware,
    rentalController.listAllRentals
  );
  router.get(
    "/rentals/:id",
    authMiddleware,
    adminMiddleware,
    rentalController.getRentalDetails
  );

  return router;
}

export { createAdminRentalController, createAdminUserController };
export const adminRouter = createAdminRouter();
export default adminRouter;
