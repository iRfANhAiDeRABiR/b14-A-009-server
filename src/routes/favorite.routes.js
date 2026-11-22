import { Router } from "express";
import {
  createFavoriteController,
  favoriteController,
} from "../controllers/favorite.controller.js";
import { verifyRenter } from "../middleware/verifyRoles.js";
import { verifyToken } from "../middleware/verifyToken.js";

/**
 * Registers customer-only Favorites endpoints (`/api/favorites`).
 * Enforces JWT authentication and canonical Customer (`verifyRenter`) role on every route.
 * Registers `/:equipmentId/status` strictly before parameterized `/:equipmentId`.
 */
export function createFavoriteRouter({
  authMiddleware = verifyToken,
  renterMiddleware = verifyRenter,
  controller = favoriteController,
} = {}) {
  const router = Router();

  router.use(authMiddleware, renterMiddleware);

  router.get("/:equipmentId/status", controller.getStatus);
  router.get("/", controller.listMine);
  router.post("/", controller.add);
  router.delete("/:equipmentId", controller.remove);

  return router;
}

export { createFavoriteController };
export const favoriteRouter = createFavoriteRouter();
export default favoriteRouter;
