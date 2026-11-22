import { fromNodeHeaders } from "better-auth/node";
import { getAuth } from "../config/auth.js";

/**
 * Retrieves the authenticated Better Auth session from an Express request
 * using the official `auth.api.getSession` + `fromNodeHeaders` integration.
 * Returns `null` when unauthenticated; never logs session tokens.
 */
export async function getSessionFromRequest(req) {
  if (!req?.headers) return null;

  const auth = getAuth();
  const result = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!result?.session || !result?.user) {
    return null;
  }

  return result;
}

/**
 * Non-blocking middleware attaching Better Auth session & user context when available.
 * Role-based verification middleware (`verifyToken`, `verifyRenter`, `verifyOwner`,
 * `verifyAdmin`) is reserved for Commit 04.
 */
export async function attachAuthSession(req, _res, next) {
  try {
    const sessionData = await getSessionFromRequest(req);
    req.authSession = sessionData?.session || null;
    req.authUser = sessionData?.user || null;
    next();
  } catch (error) {
    next(error);
  }
}
