import { Router } from "express";
import {
  ownerAnalyticsController,
} from "../controllers/ownerAnalytics.controller.js";
import {
  createOwnerRentalController,
  ownerRentalController,
} from "../controllers/ownerRental.controller.js";
import { verifyOwner } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";
import {
  createOwnerAnalyticsController,
  createOwnerAnalyticsRouter,
} from "./ownerAnalytics.routes.js";

/**
 * Registers Owner-only equipment rental management and analytics endpoints (`/api/owner`).
 */
export function createOwnerRouter({
  authMiddleware = verifyToken,
  ownerMiddleware = verifyOwner,
  rentalController = ownerRentalController,
  analyticsController = ownerAnalyticsController,
} = {}) {
  const router = Router();

  router.use(authMiddleware, ownerMiddleware);

  router.get("/rentals", rentalController.listMyRentals);
  router.get("/rentals/:id", rentalController.getMyRentalDetails);
  router.use(
    "/analytics",
    createOwnerAnalyticsRouter({
      authMiddleware,
      ownerMiddleware,
      controller: analyticsController,
    })
  );

  return router;
}

export { createOwnerAnalyticsController };

export { createOwnerRentalController };
export const ownerRouter = createOwnerRouter();
export default ownerRouter;
