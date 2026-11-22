import { Router } from "express";
import { env } from "../config/env.js";

const healthRouter = Router();

/**
 * GET /api/health
 * Verifies Express HTTP availability only; database and auth modules will be
 * integrated in subsequent milestones.
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

export { healthRouter };
export default healthRouter;
