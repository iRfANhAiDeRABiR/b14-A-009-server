import { Router } from "express";
import {
  createPaymentController,
  paymentController,
} from "../controllers/payment.controller.js";
import { verifyRenter } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

/**
 * Registers Customer Stripe Hosted Checkout payment routes (`/api/payments`).
 * Webhook endpoints requiring raw request body signatures are deferred strictly to Commit 11.
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

  return router;
}

export { createPaymentController };
export const paymentRouter = createPaymentRouter();
export default paymentRouter;
