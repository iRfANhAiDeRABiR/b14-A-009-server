import { Router } from "express";
import { checkDBHealth } from "../config/db.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const healthRouter = Router();

/**
 * GET /api/health
 * Process liveness check confirming Express HTTP availability only.
 */
healthRouter.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "GearNest API is running",
    data: {
      service: "GearNest API",
      status: "healthy",
      environment: env.nodeEnv,
    },
  });
});

/**
 * GET /api/health/ready
 * Readiness probe verifying active MongoDB connectivity without leaking credentials.
 */
healthRouter.get(
  "/ready",
  asyncHandler(async (_req, res) => {
    const dbHealth = await checkDBHealth();

    if (!dbHealth.connected) {
      return res.status(503).json({
        success: false,
        message: "GearNest database is unavailable",
        error: null,
      });
    }

    return res.status(200).json({
      success: true,
      message: "GearNest database is ready",
      data: {
        service: "GearNest API",
        database: "connected",
      },
    });
  })
);

export { healthRouter };
export default healthRouter;
