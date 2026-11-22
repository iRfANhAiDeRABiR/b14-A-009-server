import { Router } from "express";
import healthRouter from "./health.routes.js";
import protectedRouter from "./protected.routes.js";

const apiRouter = Router();

// Implemented REST modules (Commits 01-04)
// Note: Better Auth endpoints (/api/auth/*splat) are mounted in src/app.js before express.json().
apiRouter.use("/health", healthRouter);
apiRouter.use("/protected", protectedRouter);

/*
 * Planned feature module mounts (upcoming commits):
 * - /api/users      (Commit 05+)
 * - /api/equipment  (Commit 06+)
 * - /api/favorites  (Commit 07+)
 * - /api/bookings   (Commit 08+)
 * - /api/payments   (Commit 10+)
 * - /api/owner      (Commit 08+)
 * - /api/admin      (Commit 09+)
 */

export { apiRouter };
export default apiRouter;
