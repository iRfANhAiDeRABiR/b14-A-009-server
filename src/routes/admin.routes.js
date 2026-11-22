import { Router } from "express";
import {
  adminAnalyticsController,
} from "../controllers/adminAnalytics.controller.js";
import {
  createAdminAnalyticsController,
  createAdminAnalyticsRouter,
} from "./adminAnalytics.routes.js";
import {
  adminEquipmentController,
  createAdminEquipmentController,
} from "../controllers/adminEquipment.controller.js";
import {
  adminRentalController,
  createAdminRentalController,
} from "../controllers/adminRental.controller.js";
import {
  adminUserController,
  createAdminUserController,
} from "../controllers/adminUser.controller.js";
import { createAdminEquipmentRouter } from "./adminEquipment.routes.js";
import { verifyAdmin } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

export function createAdminRouter({
  authMiddleware = verifyToken,
  adminMiddleware = verifyAdmin,
  controller = adminUserController,
  rentalController = adminRentalController,
  equipmentController = adminEquipmentController,
  analyticsController = adminAnalyticsController,
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

  router.use(
    "/equipment",
    createAdminEquipmentRouter({
      authMiddleware,
      adminMiddleware,
      controller: equipmentController,
    })
  );
  router.use(
    "/analytics",
    createAdminAnalyticsRouter({
      authMiddleware,
      adminMiddleware,
      controller: analyticsController,
    })
  );

  return router;
}

export { createAdminAnalyticsController };

export {
  createAdminEquipmentController,
  createAdminRentalController,
  createAdminUserController,
};
export const adminRouter = createAdminRouter();
export default adminRouter;
