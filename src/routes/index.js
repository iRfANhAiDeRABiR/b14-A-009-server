import { Router } from "express";
import adminRouter from "./admin.routes.js";
import healthRouter from "./health.routes.js";
import protectedRouter from "./protected.routes.js";
import userRouter from "./user.routes.js";

const apiRouter = Router();

// Implemented REST modules (Commits 01-05)
// Note: Better Auth endpoints (/api/auth/*splat) are mounted in src/app.js before express.json().
apiRouter.use("/health", healthRouter);
apiRouter.use("/protected", protectedRouter);
apiRouter.use("/users", userRouter);
apiRouter.use("/admin", adminRouter);

/*
 * Planned feature module mounts (upcoming commits):
 * - /api/equipment  (Commit 06+)
 * - /api/favorites  (Commit 07+)
 * - /api/bookings   (Commit 08+)
 * - /api/payments   (Commit 10+)
 * - /api/owner      (Commit 08+)
 */

export { apiRouter };
export default apiRouter;
