import { Router } from "express";
import adminRouter from "./admin.routes.js";
import equipmentRouter from "./equipment.routes.js";
import healthRouter from "./health.routes.js";
import protectedRouter from "./protected.routes.js";
import uploadRouter from "./upload.routes.js";
import userRouter from "./user.routes.js";

const apiRouter = Router();

// Implemented REST modules (Commits 01-06)
// Note: Better Auth endpoints (/api/auth/*splat) are mounted in src/app.js before express.json().
apiRouter.use("/health", healthRouter);
apiRouter.use("/protected", protectedRouter);
apiRouter.use("/users", userRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/equipment", equipmentRouter);
apiRouter.use("/uploads", uploadRouter);

/*
 * Planned feature module mounts (upcoming commits):
 * - /api/favorites  (Commit 07/08+)
 * - /api/bookings   (Commit 08+)
 * - /api/payments   (Commit 10+)
 * - /api/owner      (Commit 09+)
 */

export { apiRouter };
export default apiRouter;
