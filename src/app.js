import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import { corsOptions } from "./config/cors.js";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import apiRouter from "./routes/index.js";

/**
 * Creates and configures the Express application instance without binding a port.
 * Separating configuration from server startup keeps routing and error handling testable.
 */
export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  if (env.isProduction) {
    app.set("trust proxy", 1);
  }

  // Security headers & restricted cross-origin policy
  app.use(helmet());
  app.use(cors(corsOptions));

  // Structured HTTP request logging (suppressed during automated tests)
  if (!env.isTest) {
    app.use(morgan(env.isProduction ? "combined" : "dev"));
  }

  // Request body parsers with explicit size limits
  app.use(express.json({ limit: env.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: env.jsonBodyLimit }));

  // Root availability endpoint
  app.get("/", (_req, res) => {
    res.status(200).json({
      success: true,
      message: "Welcome to GearNest API",
    });
  });

  // Centralized REST API routes
  app.use("/api", apiRouter);

  // Fallthrough 404 & centralized error handling
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
export default app;
