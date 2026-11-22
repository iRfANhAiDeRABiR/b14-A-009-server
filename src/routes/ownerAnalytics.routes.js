import { Router } from "express";
import {
  createOwnerAnalyticsController,
  ownerAnalyticsController,
} from "../controllers/ownerAnalytics.controller.js";
import { verifyOwner } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

/**
 * Registers Owner business & earnings analytics routes (`/api/owner/analytics`).
 */
export function createOwnerAnalyticsRouter({
  authMiddleware = verifyToken,
  ownerMiddleware = verifyOwner,
  controller = ownerAnalyticsController,
} = {}) {
  const router = Router();

  router.use(authMiddleware, ownerMiddleware);
  router.get("/", controller.getAnalytics);

  return router;
}

export { createOwnerAnalyticsController };

const ownerAnalyticsRouter = createOwnerAnalyticsRouter();
export default ownerAnalyticsRouter;
