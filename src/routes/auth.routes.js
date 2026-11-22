import { toNodeHandler } from "better-auth/node";
import { getAuth } from "../config/auth.js";

let cachedAuthRef = null;
let cachedNodeHandler = null;

function resolveNodeHandler() {
  const auth = getAuth();
  if (!cachedNodeHandler || cachedAuthRef !== auth) {
    cachedAuthRef = auth;
    cachedNodeHandler = toNodeHandler(auth);
  }
  return cachedNodeHandler;
}

/**
 * Express 5 catch-all bridge delegating `/api/auth/*splat` requests
 * directly to Better Auth BEFORE `express.json()` parses request streams.
 */
export async function betterAuthHandler(req, res, next) {
  try {
    // Express resolves req.ip from direct socket / trusted proxy; overwrite header cleanly so Better Auth keys rate-limits per client IP without client spoofing.
    const resolvedIp = req.ip || req.socket?.remoteAddress;
    if (resolvedIp) {
      req.headers["x-gearnest-client-ip"] = String(resolvedIp);
    } else {
      delete req.headers["x-gearnest-client-ip"];
    }

    const handler = resolveNodeHandler();
    await handler(req, res);
  } catch (error) {
    next(error);
  }
}
