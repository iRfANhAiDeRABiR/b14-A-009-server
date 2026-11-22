import { Router } from "express";
import {
  createOwnerRentalController,
  ownerRentalController,
} from "../controllers/ownerRental.controller.js";
import { verifyOwner } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

/**
 * Registers Owner-only equipment rental management endpoints (`/api/owner`).
 */
export function createOwnerRouter({
  authMiddleware = verifyToken,
  ownerMiddleware = verifyOwner,
  rentalController = ownerRentalController,
} = {}) {
  const router = Router();

  router.use(authMiddleware, ownerMiddleware);

  router.get("/rentals", rentalController.listMyRentals);
  router.get("/rentals/:id", rentalController.getMyRentalDetails);

  return router;
}

export { createOwnerRentalController };
export const ownerRouter = createOwnerRouter();
export default ownerRouter;
