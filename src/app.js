import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import { corsOptions } from "./config/cors.js";
import { env } from "./config/env.js";
import { paymentWebhookHandler } from "./controllers/paymentWebhook.controller.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import { betterAuthHandler } from "./routes/auth.routes.js";
import apiRouter from "./routes/index.js";

/**
 * Creates and configures the Express application instance without binding a port.
 * Separating configuration from server startup keeps routing and error handling testable.
 */
export function createApp({ webhookHandler = paymentWebhookHandler } = {}) {
  const app = express();

  app.disable("x-powered-by");

  if (env.isProduction) {
    app.set("trust proxy", 1);
  }

  // 1. Security headers & restricted cross-origin policy
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use(cors(corsOptions));

  // Structured HTTP request logging (suppressed during automated tests)
  if (!env.isTest) {
    app.use(morgan(env.isProduction ? "combined" : "dev"));
  }

  // 2. Stripe Webhook MUST precede express.json() so signature verification receives the exact raw Buffer
  app.post(
    "/api/payments/webhook",
    express.raw({ type: "application/json" }),
    webhookHandler
  );

  // 3. Better Auth handler MUST precede express.json() so request streams remain intact
  app.all("/api/auth/*splat", betterAuthHandler);

  // 4. Request body parsers with explicit size limits for Express REST endpoints
  app.use(express.json({ limit: env.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: env.jsonBodyLimit }));

  // 5. Root & centralized REST API routes
  app.get("/", (_req, res) => {
    res.status(200).json({
      success: true,
      message: "Welcome to GearNest API",
    });
  });

  app.use("/api", apiRouter);

  // 6-7. Fallthrough 404 & centralized error handling
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
export default app;
