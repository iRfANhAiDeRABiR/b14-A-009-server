import { Router } from "express";
import {
  adminAnalyticsController,
  createAdminAnalyticsController,
} from "../controllers/adminAnalytics.controller.js";
import { verifyAdmin } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

/**
 * Registers Admin platform analytics routes (`/api/admin/analytics`).
 */
export function createAdminAnalyticsRouter({
  authMiddleware = verifyToken,
  adminMiddleware = verifyAdmin,
  controller = adminAnalyticsController,
} = {}) {
  const router = Router();

  router.use(authMiddleware, adminMiddleware);
  router.get("/", controller.getAnalytics);

  return router;
}

export { createAdminAnalyticsController };

const adminAnalyticsRouter = createAdminAnalyticsRouter();
export default adminAnalyticsRouter;
