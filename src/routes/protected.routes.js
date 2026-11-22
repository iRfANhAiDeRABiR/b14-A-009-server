import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";

const protectedRouter = Router();

/**
 * GET /api/protected/me
 * Verifies the Bearer JWT via JWKS + fresh MongoDB user lookup and returns
 * only safe authenticated identity fields.
 */
protectedRouter.get("/me", verifyToken, (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      image: req.user.image,
    },
  });
});

export { protectedRouter };
export default protectedRouter;
