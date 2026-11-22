import { Router } from "express";
import healthRouter from "./health.routes.js";

const apiRouter = Router();

// Implemented routes (Commit 01)
apiRouter.use("/health", healthRouter);

/*
 * Planned feature module mounts (upcoming commits):
 * - /api/auth       (Better Auth handler in app.js — Commit 03)
 * - /api/users      (Commit 04+)
 * - /api/equipment  (Commit 05+)
 * - /api/favorites  (Commit 06+)
 * - /api/bookings   (Commit 07+)
 * - /api/payments   (Commit 10+)
 * - /api/owner      (Commit 08+)
 * - /api/admin      (Commit 09+)
 */

export { apiRouter };
export default apiRouter;
