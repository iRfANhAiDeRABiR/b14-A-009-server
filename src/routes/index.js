import { Router } from "express";
import adminRouter from "./admin.routes.js";
import bookingRouter from "./booking.routes.js";
import contactRouter from "./contact.routes.js";
import equipmentRouter from "./equipment.routes.js";
import favoriteRouter from "./favorite.routes.js";
import healthRouter from "./health.routes.js";
import ownerRouter from "./owner.routes.js";
import paymentRouter from "./payment.routes.js";
import protectedRouter from "./protected.routes.js";
import uploadRouter from "./upload.routes.js";
import userRouter from "./user.routes.js";

const apiRouter = Router();

// Mounted REST modules (Commits 01-15)
// Note: Better Auth (/api/auth/*splat) & Stripe Webhook (/api/payments/webhook) mount directly in src/app.js.
apiRouter.use("/health", healthRouter);
apiRouter.use("/protected", protectedRouter);
apiRouter.use("/users", userRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/equipment", equipmentRouter);
apiRouter.use("/uploads", uploadRouter);
apiRouter.use("/favorites", favoriteRouter);
apiRouter.use("/bookings", bookingRouter);
apiRouter.use("/payments", paymentRouter);
apiRouter.use("/owner", ownerRouter);
apiRouter.use("/contact", contactRouter);

export { apiRouter };
export default apiRouter;
