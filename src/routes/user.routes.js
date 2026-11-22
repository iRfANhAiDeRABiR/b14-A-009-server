import { Router } from "express";
import { createUserController, userController } from "../controllers/user.controller.js";
import { verifyToken } from "../middleware/verifyToken.js";

export function createUserRouter({
  authMiddleware = verifyToken,
  controller = userController,
} = {}) {
  const router = Router();

  router.get("/me", authMiddleware, controller.getMe);
  router.patch("/me", authMiddleware, controller.updateMe);

  return router;
}

export { createUserController };
export const userRouter = createUserRouter();
export default userRouter;
