import { Router } from "express";
import adminRouter from "./admin.routes.js";
import bookingRouter from "./booking.routes.js";
import equipmentRouter from "./equipment.routes.js";
import favoriteRouter from "./favorite.routes.js";
import healthRouter from "./health.routes.js";
import paymentRouter from "./payment.routes.js";
import protectedRouter from "./protected.routes.js";
import uploadRouter from "./upload.routes.js";
import userRouter from "./user.routes.js";

const apiRouter = Router();

// Implemented REST modules (Commits 01-10)
// Note: Better Auth endpoints (/api/auth/*splat) are mounted in src/app.js before express.json().
apiRouter.use("/health", healthRouter);
apiRouter.use("/protected", protectedRouter);
apiRouter.use("/users", userRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/equipment", equipmentRouter);
apiRouter.use("/uploads", uploadRouter);
apiRouter.use("/favorites", favoriteRouter);
apiRouter.use("/bookings", bookingRouter);
apiRouter.use("/payments", paymentRouter);

/*
 * Planned feature module mounts (upcoming commits):
 * - /api/owner      (Commit 11+)
 */

export { apiRouter };
export default apiRouter;
