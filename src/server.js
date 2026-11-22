import { app } from "./app.js";
import { getAuthStatusSummary, initAuth, resetAuth } from "./config/auth.js";
import { closeDB, connectDB } from "./config/db.js";
import { ensureDatabaseCollectionsAndIndexes } from "./config/dbIndexes.js";
import { env, redactMongoUri } from "./config/env.js";
import { bookingLifecycleCronService } from "./services/bookingLifecycleCron.service.js";

let httpServer = null;
let isShuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[GearNest API] ${signal} received. Starting graceful shutdown...`);

  const forceTimer = setTimeout(() => {
    console.error("[GearNest API] Forced exit after shutdown timeout.");
    process.exit(1);
  }, 10000);
  forceTimer.unref();

  try {
    bookingLifecycleCronService.stop();

    if (httpServer) {
      await new Promise((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log("[GearNest API] HTTP server closed cleanly.");
    }

    resetAuth();
    await closeDB();
    console.log("[GearNest API] MongoDB connection closed cleanly.");
    clearTimeout(forceTimer);
    process.exit(exitCode);
  } catch (error) {
    console.error(
      "[GearNest API] Error during shutdown:",
      redactMongoUri(error?.message || String(error))
    );
    clearTimeout(forceTimer);
    process.exit(1);
  }
}

async function startServer() {
  try {
    const db = await connectDB();
    console.log(`[GearNest API] Connected to MongoDB database "${db.databaseName}".`);

    const indexSummary = await ensureDatabaseCollectionsAndIndexes(db);
    console.log(
      `[GearNest API] Database initialized (${indexSummary.collectionsChecked} collections verified, ${indexSummary.indexesCreated} indexes created, ${indexSummary.indexesSkipped} existing skipped).`
    );

    initAuth();
    const authStatus = getAuthStatusSummary();
    console.log(
      `[GearNest API] Better Auth ready at ${authStatus.baseUrl}${authStatus.basePath} (Google OAuth: ${
        authStatus.googleOAuthEnabled ? "configured" : "disabled — missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET"
      }).`
    );

    bookingLifecycleCronService.start();

    httpServer = app.listen(env.port, () => {
      console.log(
        `[GearNest API] Listening on port ${env.port} (${env.nodeEnv}) — Health: /api/health`
      );
    });
    httpServer.requestTimeout = 30000;
    httpServer.keepAliveTimeout = 65000;
    httpServer.headersTimeout = 66000;

    httpServer.on("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        console.error(`[GearNest API] Port ${env.port} is already in use.`);
      } else if (error?.code === "EACCES") {
        console.error(`[GearNest API] Permission denied for port ${env.port}.`);
      } else {
        console.error(
          "[GearNest API] Failed to start HTTP server:",
          redactMongoUri(error?.message || String(error))
        );
      }
      shutdown("SERVER_LISTEN_ERROR", 1);
    });
  } catch (error) {
    console.error(
      "[GearNest API] Startup aborted:",
      redactMongoUri(error?.message || "Failed to initialize database and server.")
    );
    await closeDB().catch(() => null);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));

process.on("unhandledRejection", (reason) => {
  const safeReason =
    reason instanceof Error ? redactMongoUri(reason.message) : redactMongoUri(String(reason));
  console.error("[GearNest API] Unhandled Promise Rejection:", safeReason);
  shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (error) => {
  console.error(
    "[GearNest API] Uncaught Exception:",
    redactMongoUri(error?.message || String(error))
  );
  process.exit(1);
});

startServer();
