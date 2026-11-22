import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ObjectId } from "mongodb";

import { clearRemoteJWKSetCache, verifyJwtAccessToken } from "../src/config/jwks.js";
import { USER_ROLES } from "../src/constants/roles.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { verifyAdmin, verifyOwner, verifyRenter } from "../src/middleware/verifyRoles.js";
import { createVerifyTokenMiddleware } from "../src/middleware/verifyToken.js";
import { createAdminRouter, createAdminUserController } from "../src/routes/admin.routes.js";
import { createUserController, createUserRouter } from "../src/routes/user.routes.js";
import { createAdminUserService } from "../src/services/adminUser.service.js";
import { createUserService } from "../src/services/user.service.js";

function projectDoc(doc, projection) {
  if (!doc) return null;
  if (!projection || Object.keys(projection).length === 0) return { ...doc };
  const result = {};
  for (const key of Object.keys(projection)) {
    if (projection[key] && key in doc) {
      result[key] = doc[key];
    }
  }
  if (!("_id" in projection) && "_id" in doc) {
    result._id = doc._id;
  }
  return result;
}

function matchesFilter(doc, filter = {}) {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (filter.role !== undefined && doc.role !== filter.role) return false;
  if (Array.isArray(filter.$or)) {
    const matched = filter.$or.some((clause) => {
      for (const [k, cond] of Object.entries(clause)) {
        if (cond && typeof cond === "object" && "$regex" in cond) {
          const rx = new RegExp(cond.$regex, cond.$options || "");
          if (rx.test(String(doc[k] || ""))) return true;
        } else if (k === "_id" || k === "id") {
          if (String(doc[k]) === String(cond)) return true;
        } else if (doc[k] === cond) {
          return true;
        }
      }
      return false;
    });
    if (!matched) return false;
  }
  return true;
}

function createInMemoryUsersCollection(usersList) {
  return {
    async findOne(filter, { projection } = {}) {
      const found = usersList.find((doc) => matchesFilter(doc, filter));
      return projectDoc(found, projection);
    },

    async countDocuments(filter = {}) {
      return usersList.filter((doc) => matchesFilter(doc, filter)).length;
    },

    find(filter = {}, { projection } = {}) {
      let rows = usersList.filter((doc) => matchesFilter(doc, filter));
      let sortSpec = null;
      let skipCount = 0;
      let limitCount = rows.length;

      return {
        sort(spec) {
          sortSpec = spec;
          return this;
        },
        skip(n) {
          skipCount = n;
          return this;
        },
        limit(n) {
          limitCount = n;
          return this;
        },
        async toArray() {
          const cloned = [...rows];
          if (sortSpec) {
            cloned.sort((a, b) => {
              for (const [field, dir] of Object.entries(sortSpec)) {
                const va = a[field] instanceof Date ? a[field].getTime() : String(a[field] || "").toLowerCase();
                const vb = b[field] instanceof Date ? b[field].getTime() : String(b[field] || "").toLowerCase();
                if (va < vb) return dir === 1 ? -1 : 1;
                if (va > vb) return dir === 1 ? 1 : -1;
              }
              return 0;
            });
          }
          return cloned
            .slice(skipCount, skipCount + limitCount)
            .map((doc) => projectDoc(doc, projection));
        },
      };
    },

    async findOneAndUpdate(filter, update, { projection } = {}) {
      const target = usersList.find((doc) => matchesFilter(doc, filter));
      if (!target) return null;
      if (update?.$set) {
        Object.assign(target, update.$set);
      }
      return projectDoc(target, projection);
    },
  };
}

describe("User Profile & Admin User Governance APIs (Commit 05)", () => {
  const issuer = "http://127.0.0.1:5905";
  const audience = "http://127.0.0.1:5905";

  let keyPair;
  let jwksServer;
  let jwksUrl;
  let apiServer;
  let baseUrl;
  let usersData = [];

  const custOid = new ObjectId();
  const ownerId = "owner_ba_str_002";
  const adminId = "admin_ba_str_001";

  async function mintJwt(sub, role) {
    return new SignJWT({ role })
      .setProtectedHeader({ alg: "EdDSA", kid: "commit05-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(String(sub))
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(keyPair.privateKey);
  }

  before(async () => {
    keyPair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = "commit05-key";
    jwk.alg = "EdDSA";
    jwk.use = "sig";

    jwksServer = http.createServer((req, res) => {
      if (req.url === "/api/auth/jwks") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/api/auth/jwks`;

    const usersCollectionGetter = () => createInMemoryUsersCollection(usersData);

    const verifyTokenMiddleware = createVerifyTokenMiddleware({
      usersCollectionGetter,
      verifyAccessToken: (token) =>
        verifyJwtAccessToken(token, { jwksUrl, issuer, audience }),
    });

    const userSvc = createUserService({ usersCollectionGetter });
    const adminUserSvc = createAdminUserService({ usersCollectionGetter });

    const app = express();
    app.use(express.json());
    app.use(
      "/api/users",
      createUserRouter({
        authMiddleware: verifyTokenMiddleware,
        controller: createUserController(userSvc),
      })
    );
    app.use(
      "/api/admin",
      createAdminRouter({
        authMiddleware: verifyTokenMiddleware,
        adminMiddleware: verifyAdmin,
        controller: createAdminUserController(adminUserSvc),
      })
    );
    app.get("/api/probe/owner", verifyTokenMiddleware, verifyOwner, (_req, res) => {
      res.status(200).json({ success: true });
    });
    app.get("/api/probe/renter", verifyTokenMiddleware, verifyRenter, (_req, res) => {
      res.status(200).json({ success: true });
    });
    app.use(errorHandler);

    apiServer = http.createServer(app);
    await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
  });

  after(async () => {
    clearRemoteJWKSetCache();
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => jwksServer.close(resolve));
  });

  beforeEach(() => {
    usersData = [
      {
        _id: custOid,
        name: "Tanvir Hasan",
        email: "tanvir@example.com",
        emailVerified: false,
        image: "https://i.ibb.co/example/tanvir.jpg",
        phone: "01711112222",
        address: "Dhanmondi, Dhaka",
        role: USER_ROLES.CUSTOMER,
        passwordHash: "$2b$10$DO_NOT_LEAK_HASH",
        sessionToken: "PRIVATE_SESSION_SECRET",
        oauthAccessToken: "PRIVATE_OAUTH_TOKEN",
        createdAt: new Date("2026-10-01T10:00:00.000Z"),
        updatedAt: new Date("2026-10-01T10:00:00.000Z"),
      },
      {
        _id: ownerId,
        id: ownerId,
        name: "Farhan Equipment",
        email: "farhan@owner.com",
        emailVerified: true,
        image: null,
        phone: "+8801812345678",
        address: "Uttara, Dhaka",
        role: USER_ROLES.OWNER,
        passwordHash: "$2b$10$DO_NOT_LEAK_OWNER_HASH",
        createdAt: new Date("2026-10-05T10:00:00.000Z"),
        updatedAt: new Date("2026-10-05T10:00:00.000Z"),
      },
      {
        _id: adminId,
        id: adminId,
        name: "Nadia Admin",
        email: "nadia@gearnest.example",
        emailVerified: true,
        image: null,
        phone: "01900001111",
        address: "Banani, Dhaka",
        role: USER_ROLES.ADMIN,
        passwordHash: "$2b$10$DO_NOT_LEAK_ADMIN_HASH",
        createdAt: new Date("2026-09-20T10:00:00.000Z"),
        updatedAt: new Date("2026-09-20T10:00:00.000Z"),
      },
      {
        _id: "cust_ba_str_004",
        id: "cust_ba_str_004",
        name: "Ayesha Akter",
        email: "ayesha@example.com",
        emailVerified: false,
        image: null,
        phone: "01611223344",
        address: "Chittagong",
        role: USER_ROLES.CUSTOMER,
        createdAt: new Date("2026-11-01T10:00:00.000Z"),
        updatedAt: new Date("2026-11-01T10:00:00.000Z"),
      },
    ];
  });

  test("PROFILE TESTS: Get & Update Profiles for Customer, Owner, Admin + Validation", async () => {
    const custToken = await mintJwt(custOid.toHexString(), USER_ROLES.CUSTOMER);
    const ownerToken = await mintJwt(ownerId, USER_ROLES.OWNER);
    const adminToken = await mintJwt(adminId, USER_ROLES.ADMIN);

    // Get profiles across all 3 roles & verify zero sensitive data leakage
    for (const [token, expectedRole, expectedEmail] of [
      [custToken, USER_ROLES.CUSTOMER, "tanvir@example.com"],
      [ownerToken, USER_ROLES.OWNER, "farhan@owner.com"],
      [adminToken, USER_ROLES.ADMIN, "nadia@gearnest.example"],
    ]) {
      const res = await fetch(`${baseUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.success, true);
      assert.equal(json.data.role, expectedRole);
      assert.equal(json.data.email, expectedEmail);
      assert.equal(json.data.passwordHash, undefined);
      assert.equal(json.data.sessionToken, undefined);
      assert.equal(json.data.oauthAccessToken, undefined);
    }

    // Missing token -> 401
    const unauthRes = await fetch(`${baseUrl}/api/users/me`);
    assert.equal(unauthRes.status, 401);

    // Update name, image, phone, address cleanly
    const patchRes = await fetch(`${baseUrl}/api/users/me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${custToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "  Tanvir Updated  ",
        image: "https://i.ibb.co/updated/avatar.png",
        phone: "01799887766",
        address: "  Gulshan 1, Dhaka  ",
      }),
    });
    const patchJson = await patchRes.json();
    assert.equal(patchRes.status, 200);
    assert.equal(patchJson.data.name, "Tanvir Updated");
    assert.equal(patchJson.data.image, "https://i.ibb.co/updated/avatar.png");
    assert.equal(patchJson.data.phone, "01799887766");
    assert.equal(patchJson.data.address, "Gulshan 1, Dhaka");
    assert.equal(patchJson.data.role, USER_ROLES.CUSTOMER);

    // Frontend photoURL alias compatibility + clearing optional image cleanly
    const photoAliasRes = await fetch(`${baseUrl}/api/users/me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ photoURL: "https://i.ibb.co/owner/logo.jpg" }),
    });
    const photoAliasJson = await photoAliasRes.json();
    assert.equal(photoAliasRes.status, 200);
    assert.equal(photoAliasJson.data.image, "https://i.ibb.co/owner/logo.jpg");

    // Validation failures: empty name, invalid image URL, invalid phone
    for (const badBody of [
      { name: "   " },
      { image: "javascript:alert(1)" },
      { phone: "invalid-phone" },
      { phone: "123" },
    ]) {
      const badRes = await fetch(`${baseUrl}/api/users/me`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${custToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(badBody),
      });
      assert.equal(badRes.status, 400);
    }

    // Deleted user fails verifyToken -> 401
    usersData = usersData.filter((u) => String(u._id) !== String(custOid));
    const deletedRes = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${custToken}` },
    });
    assert.equal(deletedRes.status, 401);
  });

  test("PROFILE SECURITY: Reject role/email/emailVerified/password/userId mass assignment", async () => {
    const custToken = await mintJwt(custOid.toHexString(), USER_ROLES.CUSTOMER);

    for (const attackBody of [
      { role: "Admin" },
      { email: "hacker@example.com" },
      { emailVerified: true },
      { password: "NewPassword1" },
      { userId: ownerId, name: "Hijack" },
      { _id: adminId, name: "Hijack" },
    ]) {
      const res = await fetch(`${baseUrl}/api/users/me`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${custToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(attackBody),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.success, false);
    }

    // Verify record remained unchanged in database
    const intact = usersData.find((u) => String(u._id) === custOid.toHexString());
    assert.equal(intact.role, USER_ROLES.CUSTOMER);
    assert.equal(intact.email, "tanvir@example.com");
    assert.equal(intact.emailVerified, false);
  });

  test("ADMIN USER TESTS: Listing, Regex-Safe Search, Role Filters, Sorting, Pagination & Details", async () => {
    const adminToken = await mintJwt(adminId, USER_ROLES.ADMIN);

    // Retrieve all users (default page=1, limit=10, newest)
    let res = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 4);
    assert.deepEqual(json.pagination, {
      currentPage: 1,
      limit: 10,
      totalItems: 4,
      totalPages: 1,
    });
    assert.equal(json.data[0].name, "Ayesha Akter"); // Newest registration first
    assert.equal(json.data[0].passwordHash, undefined);

    // Search by name
    res = await fetch(`${baseUrl}/api/admin/users?search=tanvir`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].email, "tanvir@example.com");

    // Search by email with regex metacharacters safely escaped
    res = await fetch(`${baseUrl}/api/admin/users?search=${encodeURIComponent("farhan@owner.com")}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].role, USER_ROLES.OWNER);

    res = await fetch(`${baseUrl}/api/admin/users?search=${encodeURIComponent(".*[(")}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.length, 0);

    // Role filters: Customer, Owner, Admin
    for (const [roleFilter, expectedCount] of [
      ["Customer", 2],
      ["Owner", 1],
      ["Admin", 1],
    ]) {
      res = await fetch(`${baseUrl}/api/admin/users?role=${roleFilter}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.data.length, expectedCount);
    }

    // Invalid role filter -> 400
    res = await fetch(`${baseUrl}/api/admin/users?role=SuperUser`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 400);

    // Pagination & sorting (name_asc, page=2, limit=2)
    res = await fetch(`${baseUrl}/api/admin/users?sort=name_asc&page=1&limit=2`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 2);
    assert.deepEqual(
      json.data.map((u) => u.name),
      ["Ayesha Akter", "Farhan Equipment"]
    );
    assert.equal(json.pagination.totalPages, 2);

    // Details: ObjectId user & String user + nonexistent 404 + malformed 400
    res = await fetch(`${baseUrl}/api/admin/users/${custOid.toHexString()}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.address, "Dhanmondi, Dhaka");
    assert.equal(json.data.passwordHash, undefined);

    res = await fetch(`${baseUrl}/api/admin/users/nonexistent_user_999`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 404);

    res = await fetch(`${baseUrl}/api/admin/users/ab`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 400);
  });

  test("ROLE MANAGEMENT TESTS: Promotions, Demotions, Self-Change Block & Stale JWT Override", async () => {
    const custToken = await mintJwt(custOid.toHexString(), USER_ROLES.CUSTOMER);
    const ownerToken = await mintJwt(ownerId, USER_ROLES.OWNER);
    const adminToken = await mintJwt(adminId, USER_ROLES.ADMIN);

    // Non-admin & unauthenticated requests rejected
    assert.equal((await fetch(`${baseUrl}/api/admin/users`)).status, 401);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/admin/users/${custOid.toHexString()}/role`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${custToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ role: "Admin" }),
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/admin/users/${custOid.toHexString()}/role`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ role: "Owner" }),
        })
      ).status,
      403
    );

    // Admin prevents self-role change
    const selfRes = await fetch(`${baseUrl}/api/admin/users/${adminId}/role`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "Customer" }),
    });
    assert.equal(selfRes.status, 400);

    // Admin changes Customer -> Owner: DB & subsequent verifyToken enforce Owner immediately
    assert.equal(
      (
        await fetch(`${baseUrl}/api/probe/owner`, {
          headers: { Authorization: `Bearer ${custToken}` },
        })
      ).status,
      403
    );

    let roleRes = await fetch(`${baseUrl}/api/admin/users/${custOid.toHexString()}/role`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "Owner" }),
    });
    assert.equal(roleRes.status, 200);
    assert.equal((await roleRes.json()).data.role, USER_ROLES.OWNER);

    // Same token (even though JWT claim still says Customer) now reflects DB role Owner!
    assert.equal(
      (
        await fetch(`${baseUrl}/api/probe/owner`, {
          headers: { Authorization: `Bearer ${custToken}` },
        })
      ).status,
      200
    );

    // Idempotent message when assigning same role again
    roleRes = await fetch(`${baseUrl}/api/admin/users/${custOid.toHexString()}/role`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "Owner" }),
    });
    assert.equal(roleRes.status, 200);
    assert.match((await roleRes.json()).message, /already has/i);

    // Promote to Admin -> verify stale Owner token cannot keep Owner/Admin after demotion back to Customer
    const ownerJwtForSameUser = await mintJwt(custOid.toHexString(), USER_ROLES.ADMIN);
    roleRes = await fetch(`${baseUrl}/api/admin/users/${custOid.toHexString()}/role`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "Admin" }),
    });
    assert.equal(roleRes.status, 200);

    // Now demote back to Customer
    roleRes = await fetch(`${baseUrl}/api/admin/users/${custOid.toHexString()}/role`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "Customer" }),
    });
    assert.equal(roleRes.status, 200);

    // Stale JWT with role="Admin" MUST be denied by verifyOwner & verifyAdmin because DB role is Customer!
    assert.equal(
      (
        await fetch(`${baseUrl}/api/probe/owner`, {
          headers: { Authorization: `Bearer ${ownerJwtForSameUser}` },
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/admin/users`, {
          headers: { Authorization: `Bearer ${ownerJwtForSameUser}` },
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/probe/renter`, {
          headers: { Authorization: `Bearer ${ownerJwtForSameUser}` },
        })
      ).status,
      200
    );

    // Invalid role value rejected cleanly -> 400
    const badRoleRes = await fetch(`${baseUrl}/api/admin/users/${ownerId}/role`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "Root" }),
    });
    assert.equal(badRoleRes.status, 400);
  });
});
