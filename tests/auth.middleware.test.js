import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import express from "express";
import { memoryAdapter } from "better-auth/adapters/memory";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ObjectId } from "mongodb";

import { initAuth, resetAuth } from "../src/config/auth.js";
import { clearRemoteJWKSetCache, verifyJwtAccessToken } from "../src/config/jwks.js";
import { USER_ROLES } from "../src/constants/roles.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
  isResourceOwner,
  verifyAdmin,
  verifyOwner,
  verifyRenter,
} from "../src/middleware/verifyRoles.js";
import { createVerifyTokenMiddleware } from "../src/middleware/verifyToken.js";

function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createFakeUsersCollection(userStore) {
  return {
    async findOne(query) {
      const candidates = Array.isArray(query?.$or) ? query.$or : [query];
      for (const user of userStore.values()) {
        for (const cond of candidates) {
          if (cond._id !== undefined && String(user._id) === String(cond._id)) {
            return user;
          }
          if (cond.id !== undefined && String(user.id) === String(cond.id)) {
            return user;
          }
        }
      }
      return null;
    },
  };
}

describe("JWT Verification & RBAC Middleware (Commit 04)", () => {
  const issuer = "http://127.0.0.1:5900";
  const audience = "http://127.0.0.1:5900";

  let primaryKeyPair;
  let rotatedKeyPair;
  let activeKeys = [];
  let jwksFetchCount = 0;
  let jwksUnavailable = false;
  let jwksServer;
  let jwksUrl;

  const usersById = new Map();
  let testServer;
  let apiBaseUrl;

  async function signTestJwt(
    claims = {},
    {
      privateKey = primaryKeyPair.privateKey,
      kid = "key-1",
      alg = "EdDSA",
      iss = issuer,
      aud = audience,
      expiresIn = "15m",
      omitSub = false,
      explicitSubject,
    } = {}
  ) {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg, ...(kid ? { kid } : {}) })
      .setIssuedAt();

    if (iss !== null) jwt.setIssuer(iss);
    if (aud !== null) jwt.setAudience(aud);
    if (expiresIn !== null) jwt.setExpirationTime(expiresIn);
    if (!omitSub) {
      jwt.setSubject(explicitSubject || "user_customer_1");
    }

    return jwt.sign(privateKey);
  }

  before(async () => {
    primaryKeyPair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    rotatedKeyPair = await generateKeyPair("EdDSA", { crv: "Ed25519" });

    const primaryJwk = await exportJWK(primaryKeyPair.publicKey);
    primaryJwk.kid = "key-1";
    primaryJwk.alg = "EdDSA";
    primaryJwk.use = "sig";

    activeKeys = [primaryJwk];

    jwksServer = http.createServer((req, res) => {
      if (req.url === "/api/auth/jwks") {
        jwksFetchCount += 1;
        if (jwksUnavailable) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Unavailable" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: activeKeys }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    const jwksPort = jwksServer.address().port;
    jwksUrl = `http://127.0.0.1:${jwksPort}/api/auth/jwks`;

    const verifyTokenWithTestJwks = createVerifyTokenMiddleware({
      usersCollectionGetter: () => createFakeUsersCollection(usersById),
      verifyAccessToken: (token) =>
        verifyJwtAccessToken(token, { jwksUrl, issuer, audience }),
    });

    const app = express();
    app.use(express.json());

    app.get("/health", (_req, res) => {
      res.status(200).json({ success: true });
    });

    app.get("/me", verifyTokenWithTestJwks, (req, res) => {
      res.status(200).json({ success: true, user: req.user, auth: req.auth });
    });

    app.get(
      "/renter-only",
      verifyTokenWithTestJwks,
      verifyRenter,
      (req, res) => res.status(200).json({ success: true, role: req.user.role })
    );

    app.get(
      "/owner-only",
      verifyTokenWithTestJwks,
      verifyOwner,
      (req, res) => res.status(200).json({ success: true, role: req.user.role })
    );

    app.get(
      "/admin-only",
      verifyTokenWithTestJwks,
      verifyAdmin,
      (req, res) => res.status(200).json({ success: true, role: req.user.role })
    );

    app.post("/ownership-check", verifyTokenWithTestJwks, (req, res) => {
      const ownsTarget = isResourceOwner(req.query.resourceOwnerId, req);
      res.status(200).json({
        success: true,
        userId: req.user.id,
        ownsTarget,
      });
    });

    app.use(errorHandler);

    testServer = http.createServer(app);
    await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${testServer.address().port}`;
  });

  after(async () => {
    clearRemoteJWKSetCache();
    await new Promise((resolve) => testServer.close(resolve));
    await new Promise((resolve) => jwksServer.close(resolve));
  });

  test("Token Extraction & Cryptographic Verification Error Cases", async () => {
    usersById.clear();
    usersById.set("user_customer_1", {
      _id: "user_customer_1",
      id: "user_customer_1",
      name: "Customer One",
      email: "customer@example.com",
      role: USER_ROLES.CUSTOMER,
      image: null,
      passwordHash: "MUST_NEVER_BE_EXPOSED",
    });

    // Missing Authorization header
    let res = await fetch(`${apiBaseUrl}/me`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      success: false,
      message: "Authentication required",
    });

    // Empty Bearer token
    for (const authValue of ["Bearer", "Bearer   "]) {
      res = await fetch(`${apiBaseUrl}/me`, { headers: { Authorization: authValue } });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), {
        success: false,
        message: "Authentication required",
      });
    }

    // Malformed Authorization header
    for (const authValue of ["Basic dXNlcjpwYXNz", "Token abc", "Bearer token extra"]) {
      res = await fetch(`${apiBaseUrl}/me`, { headers: { Authorization: authValue } });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), {
        success: false,
        message: "Invalid or expired access token",
      });
    }

    // Invalid JWT syntax
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: "Bearer not.a.jwt" },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      success: false,
      message: "Invalid or expired access token",
    });

    // Tampered signature
    const validToken = await signTestJwt({ role: USER_ROLES.CUSTOMER });
    const parts = validToken.split(".");
    const tamperedSig = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -3)}xxx`;
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${tamperedSig}` },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).message, "Invalid or expired access token");

    // Expired JWT
    const expiredToken = await signTestJwt({}, { expiresIn: "-5m" });
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      success: false,
      message: "Your session has expired. Please log in again.",
    });

    // Wrong issuer
    const wrongIssuerToken = await signTestJwt({}, { iss: "https://wrong.example.com" });
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${wrongIssuerToken}` },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).message, "Invalid or expired access token");

    // Wrong audience
    const wrongAudToken = await signTestJwt({}, { aud: "https://wrong.example.com" });
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${wrongAudToken}` },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).message, "Invalid or expired access token");

    // Missing subject claim
    const missingSubToken = await signTestJwt({}, { omitSub: true });
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${missingSubToken}` },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).message, "Invalid or expired access token");

    // Unsupported algorithms: alg=none and HS256
    const algNoneHeader = toBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const algNonePayload = toBase64Url(
      JSON.stringify({
        sub: "user_customer_1",
        iss: issuer,
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 600,
      })
    );
    const algNoneToken = `${algNoneHeader}.${algNonePayload}.`;
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${algNoneToken}` },
    });
    assert.equal(res.status, 401);

    const hs256Token = await new SignJWT({ role: USER_ROLES.ADMIN })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("user_customer_1")
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode("super-secret-hs256-test-signing-key-value"));
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${hs256Token}` },
    });
    assert.equal(res.status, 401);

    // Unknown kid -> rejected 401
    const unknownKidToken = await signTestJwt({}, { kid: "nonexistent-kid" });
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${unknownKidToken}` },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).message, "Invalid or expired access token");

    // JWKS unavailable (cold cache) -> fail closed with 503
    clearRemoteJWKSetCache();
    jwksUnavailable = true;
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${validToken}` },
    });
    assert.equal(res.status, 503);
    jwksUnavailable = false;
  });

  test("JWKS Caching, Key Rotation, ObjectId/String Users & Missing/Invalid DB Users", async () => {
    clearRemoteJWKSetCache();
    jwksFetchCount = 0;

    const objectIdUserId = new ObjectId();
    usersById.clear();
    usersById.set(objectIdUserId.toHexString(), {
      _id: objectIdUserId,
      name: "ObjectId Owner",
      email: "oid-owner@example.com",
      role: USER_ROLES.OWNER,
      image: "https://example.com/avatar.png",
      passwordHash: "SECRET_HASH",
    });

    const token1 = await signTestJwt({}, { explicitSubject: objectIdUserId.toHexString() });
    let res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.equal(res.status, 200);
    const body1 = await res.json();
    assert.equal(body1.user.id, objectIdUserId.toHexString());
    assert.equal(body1.user.role, USER_ROLES.OWNER);
    assert.equal(body1.user.passwordHash, undefined);

    // Second request reuses cached JWKS without additional HTTP fetches
    const fetchesAfterFirst = jwksFetchCount;
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.equal(res.status, 200);
    assert.equal(jwksFetchCount, fetchesAfterFirst);

    // Rotate key & sign with key-2 -> JWKS resolver refreshes automatically
    const rotatedJwk = await exportJWK(rotatedKeyPair.publicKey);
    rotatedJwk.kid = "key-2";
    rotatedJwk.alg = "EdDSA";
    rotatedJwk.use = "sig";
    activeKeys = [...activeKeys, rotatedJwk];

    clearRemoteJWKSetCache();
    const rotatedToken = await signTestJwt(
      {},
      {
        privateKey: rotatedKeyPair.privateKey,
        kid: "key-2",
        explicitSubject: objectIdUserId.toHexString(),
      }
    );
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${rotatedToken}` },
    });
    assert.equal(res.status, 200);

    // Deleted user
    const deletedToken = await signTestJwt({}, { explicitSubject: "deleted_user_999" });
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${deletedToken}` },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      success: false,
      message: "Authenticated user not found",
    });

    // Invalid DB user record (missing _id and id)
    usersById.set("broken_user", {
      name: "Broken",
      email: "broken@example.com",
      role: USER_ROLES.CUSTOMER,
    });
    // Note: createFakeUsersCollection requires an id match if not found; test explicit invalid role record
    usersById.set("invalid_role_user", {
      _id: "invalid_role_user",
      id: "invalid_role_user",
      name: "Bad Role",
      email: "badrole@example.com",
      role: "Superuser",
    });
    const invalidRoleToken = await signTestJwt({}, { explicitSubject: "invalid_role_user" });
    res = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${invalidRoleToken}` },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      success: false,
      message: "Your account does not have a valid role",
    });
  });

  test("RBAC Role Guards, Stale JWT Role Override, Disabled Accounts & Ownership Rules", async () => {
    usersById.clear();
    usersById.set("cust_1", {
      _id: "cust_1",
      id: "cust_1",
      name: "Customer",
      email: "c@example.com",
      role: USER_ROLES.CUSTOMER,
    });
    usersById.set("owner_1", {
      _id: "owner_1",
      id: "owner_1",
      name: "Owner",
      email: "o@example.com",
      role: USER_ROLES.OWNER,
    });
    usersById.set("admin_1", {
      _id: "admin_1",
      id: "admin_1",
      name: "Admin",
      email: "a@example.com",
      role: USER_ROLES.ADMIN,
    });
    usersById.set("suspended_1", {
      _id: "suspended_1",
      id: "suspended_1",
      name: "Suspended",
      email: "s@example.com",
      role: USER_ROLES.CUSTOMER,
      suspended: true,
    });
    usersById.set("missing_role_1", {
      _id: "missing_role_1",
      id: "missing_role_1",
      name: "No Role",
      email: "n@example.com",
    });

    const custToken = await signTestJwt({ role: USER_ROLES.CUSTOMER }, { explicitSubject: "cust_1" });
    const ownerToken = await signTestJwt({ role: USER_ROLES.OWNER }, { explicitSubject: "owner_1" });
    const adminToken = await signTestJwt({ role: USER_ROLES.ADMIN }, { explicitSubject: "admin_1" });

    // Customer passes verifyRenter, fails verifyOwner & verifyAdmin
    assert.equal((await fetch(`${apiBaseUrl}/renter-only`, { headers: { Authorization: `Bearer ${custToken}` } })).status, 200);
    assert.equal((await fetch(`${apiBaseUrl}/owner-only`, { headers: { Authorization: `Bearer ${custToken}` } })).status, 403);
    assert.equal((await fetch(`${apiBaseUrl}/admin-only`, { headers: { Authorization: `Bearer ${custToken}` } })).status, 403);

    // Owner passes verifyOwner, fails verifyRenter & verifyAdmin
    assert.equal((await fetch(`${apiBaseUrl}/owner-only`, { headers: { Authorization: `Bearer ${ownerToken}` } })).status, 200);
    assert.equal((await fetch(`${apiBaseUrl}/renter-only`, { headers: { Authorization: `Bearer ${ownerToken}` } })).status, 403);
    assert.equal((await fetch(`${apiBaseUrl}/admin-only`, { headers: { Authorization: `Bearer ${ownerToken}` } })).status, 403);

    // Admin passes verifyAdmin, fails verifyRenter & verifyOwner
    assert.equal((await fetch(`${apiBaseUrl}/admin-only`, { headers: { Authorization: `Bearer ${adminToken}` } })).status, 200);
    assert.equal((await fetch(`${apiBaseUrl}/renter-only`, { headers: { Authorization: `Bearer ${adminToken}` } })).status, 403);
    assert.equal((await fetch(`${apiBaseUrl}/owner-only`, { headers: { Authorization: `Bearer ${adminToken}` } })).status, 403);

    // Missing DB role rejected 403
    const missingRoleToken = await signTestJwt({ role: USER_ROLES.ADMIN }, { explicitSubject: "missing_role_1" });
    const missingRoleRes = await fetch(`${apiBaseUrl}/admin-only`, {
      headers: { Authorization: `Bearer ${missingRoleToken}` },
    });
    assert.equal(missingRoleRes.status, 403);
    assert.equal((await missingRoleRes.json()).message, "Your account does not have a valid role");

    // Disabled / suspended user rejected cleanly
    const suspendedToken = await signTestJwt({}, { explicitSubject: "suspended_1" });
    const suspendedRes = await fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${suspendedToken}` },
    });
    assert.equal(suspendedRes.status, 403);

    // CRITICAL SECURITY TEST: Stale JWT claims role="Admin", DB role was downgraded to "Customer"
    const staleAdminToken = await signTestJwt({ role: USER_ROLES.ADMIN }, { explicitSubject: "cust_1" });
    const downgradedAdminRes = await fetch(`${apiBaseUrl}/admin-only`, {
      headers: { Authorization: `Bearer ${staleAdminToken}` },
    });
    assert.equal(downgradedAdminRes.status, 403);
    assert.equal((await downgradedAdminRes.json()).message, "Admin access required");

    // Spoofed req.body.userId / req.body.ownerId cannot override verified JWT user
    const ownershipRes = await fetch(`${apiBaseUrl}/ownership-check?resourceOwnerId=owner_1`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${custToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: "owner_1", ownerId: "owner_1", role: "Admin" }),
    });
    const ownershipJson = await ownershipRes.json();
    assert.equal(ownershipJson.userId, "cust_1");
    assert.equal(ownershipJson.ownsTarget, false);

    // Public route stays open without Authorization
    assert.equal((await fetch(`${apiBaseUrl}/health`)).status, 200);
  });

  test("End-to-End Express App + Better Auth Token + /api/protected/me + Public Health Checks", async () => {
    const store = {
      user: [],
      users: [],
      session: [],
      sessions: [],
      account: [],
      accounts: [],
      verification: [],
      verifications: [],
      jwks: [],
    };

    const { createApp } = await import("../src/app.js");
    const app = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const prevSecret = process.env.BETTER_AUTH_SECRET;
    const prevUrl = process.env.BETTER_AUTH_URL;
    const prevJwks = process.env.BETTER_AUTH_JWKS_URL;
    const prevIss = process.env.BETTER_AUTH_ISSUER;
    const prevAud = process.env.BETTER_AUTH_AUDIENCE;

    try {
      process.env.BETTER_AUTH_SECRET = crypto.randomBytes(32).toString("hex");
      process.env.BETTER_AUTH_URL = baseUrl;
      process.env.BETTER_AUTH_JWKS_URL = `${baseUrl}/api/auth/jwks`;
      process.env.BETTER_AUTH_ISSUER = baseUrl;
      process.env.BETTER_AUTH_AUDIENCE = baseUrl;

      resetAuth();
      clearRemoteJWKSetCache();
      initAuth({ databaseOverride: memoryAdapter(store) });

      // Public liveness stays accessible
      const pubHealth = await fetch(`${baseUrl}/api/health`);
      assert.equal(pubHealth.status, 200);

      // /api/protected/me without Bearer token -> 401
      const unauthProtected = await fetch(`${baseUrl}/api/protected/me`);
      assert.equal(unauthProtected.status, 401);
      assert.deepEqual(await unauthProtected.json(), {
        success: false,
        message: "Authentication required",
      });

      // Signup via Better Auth from trusted frontend origin -> mint JWT -> verify via JWKS
      const signupRes = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          name: "E2E Verifier",
          email: "e2e@example.com",
          password: "ValidPass1",
        }),
      });
      assert.equal(signupRes.status, 200);
      assert.equal(
        signupRes.headers.get("access-control-allow-origin"),
        "http://localhost:3000"
      );
      const cookie = (signupRes.headers.getSetCookie?.() || [])
        .map((c) => c.split(";")[0])
        .join("; ");

      const tokenRes = await fetch(`${baseUrl}/api/auth/token`, {
        headers: {
          Cookie: cookie,
          Origin: "http://localhost:3000",
        },
      });
      const tokenJson = await tokenRes.json();
      assert.equal(tokenRes.status, 200);
      assert.ok(typeof tokenJson.token === "string");

      // Cryptographically verify the Better Auth token using jwks.js against /api/auth/jwks
      const verified = await verifyJwtAccessToken(tokenJson.token);
      assert.equal(verified.email, "e2e@example.com");
      assert.equal(verified.role, USER_ROLES.CUSTOMER);

      // Mount isolated protected route sharing real verifyJwtAccessToken + in-memory users
      const storedUser = store.user[0] || store.users[0];
      assert.ok(storedUser, "User should be stored by Better Auth");
      const guard = createVerifyTokenMiddleware({
        usersCollectionGetter: () => ({
          async findOne() {
            return storedUser;
          },
        }),
      });
      const reqMock = { headers: { authorization: `Bearer ${tokenJson.token}` } };
      let nextErr = null;
      await guard(reqMock, {}, (err) => {
        nextErr = err || null;
      });
      assert.equal(nextErr, null);
      assert.equal(reqMock.user?.email, "e2e@example.com");
      assert.equal(reqMock.user?.role, USER_ROLES.CUSTOMER);
      assert.equal(reqMock.user?.password, undefined);
    } finally {
      process.env.BETTER_AUTH_SECRET = prevSecret;
      process.env.BETTER_AUTH_URL = prevUrl;
      process.env.BETTER_AUTH_JWKS_URL = prevJwks;
      process.env.BETTER_AUTH_ISSUER = prevIss;
      process.env.BETTER_AUTH_AUDIENCE = prevAud;
      resetAuth();
      clearRemoteJWKSetCache();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
