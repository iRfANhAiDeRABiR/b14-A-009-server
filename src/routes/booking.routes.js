import { Router } from "express";
import {
  bookingController,
  createBookingController,
} from "../controllers/booking.controller.js";
import { verifyRenter } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

/**
 * Registers Customer booking & availability routes (`/api/bookings`).
 * Enforces JWT authentication and canonical Customer (`verifyRenter`) role on every endpoint.
 * Registers static routes (`/check-availability`, `/my`) strictly before parameterized `/:id`.
 */
export function createBookingRouter({
  authMiddleware = verifyToken,
  renterMiddleware = verifyRenter,
  controller = bookingController,
} = {}) {
  const router = Router();

  router.use(authMiddleware, renterMiddleware);

  router.post("/check-availability", controller.checkAvailability);
  router.get("/my", controller.listMyBookings);
  router.post("/", controller.createReservation);
  router.get("/:id", controller.getMyBookingDetails);

  return router;
}

export { createBookingController };
export const bookingRouter = createBookingRouter();
export default bookingRouter;
