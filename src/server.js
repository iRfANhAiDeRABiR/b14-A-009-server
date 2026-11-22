import { app } from "./app.js";
import { env } from "./config/env.js";

const server = app.listen(env.port, () => {
  console.log(
    `[GearNest API] Listening on port ${env.port} (${env.nodeEnv}) — Health: /api/health`
  );
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`[GearNest API] Port ${env.port} is already in use.`);
  } else if (error?.code === "EACCES") {
    console.error(`[GearNest API] Permission denied for port ${env.port}.`);
  } else {
    console.error("[GearNest API] Failed to start HTTP server:", error);
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log(`[GearNest API] ${signal} received. Closing HTTP server...`);
  server.close((err) => {
    if (err) {
      console.error("[GearNest API] Error during server shutdown:", err);
      process.exit(1);
    }
    console.log("[GearNest API] HTTP server closed cleanly.");
    process.exit(0);
  });

  // Force exit if active sockets linger past timeout
  setTimeout(() => {
    console.error("[GearNest API] Forced exit after shutdown timeout.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  console.error("[GearNest API] Unhandled Promise Rejection:", reason);
  shutdown("unhandledRejection");
});

process.on("uncaughtException", (error) => {
  console.error("[GearNest API] Uncaught Exception:", error);
  process.exit(1);
});
