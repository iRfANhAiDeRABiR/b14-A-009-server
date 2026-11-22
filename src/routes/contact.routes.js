import { Router } from "express";
import {
  contactController,
  createContactController,
} from "../controllers/contact.controller.js";
import { contactRateLimiter } from "../middleware/rateLimiter.js";

/**
 * Registers public contact inquiry endpoints (`/api/contact`) with abuse throttling.
 */
export function createContactRouter({
  rateLimiter = contactRateLimiter,
  controller = contactController,
} = {}) {
  const router = Router();

  router.post("/", rateLimiter, controller.submitMessage);

  return router;
}

export { createContactController };
export const contactRouter = createContactRouter();
export default contactRouter;
