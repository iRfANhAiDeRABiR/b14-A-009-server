import { Router } from "express";
import {
  createPaymentController,
  paymentController,
} from "../controllers/payment.controller.js";
import { verifyRenter } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

/**
 * Registers Customer Stripe Hosted Checkout & read-only status payment routes (`/api/payments`).
 * Note: `POST /api/payments/webhook` requires raw binary body parsing and is mounted BEFORE
 * `express.json()` directly inside `src/app.js`.
 */
export function createPaymentRouter({
  authMiddleware = verifyToken,
  renterMiddleware = verifyRenter,
  controller = paymentController,
} = {}) {
  const router = Router();

  router.post(
    "/create-checkout-session",
    authMiddleware,
    renterMiddleware,
    controller.createCheckoutSession
  );

  router.get(
    "/session/:sessionId",
    authMiddleware,
    renterMiddleware,
    controller.getSessionStatus
  );

  return router;
}

export { createPaymentController };
export const paymentRouter = createPaymentRouter();
export default paymentRouter;
