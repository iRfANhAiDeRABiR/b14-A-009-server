import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ObjectId } from "mongodb";

import { clearRemoteJWKSetCache, verifyJwtAccessToken } from "../src/config/jwks.js";
import { EQUIPMENT_STATUSES } from "../src/constants/equipment.js";
import { USER_ROLES } from "../src/constants/roles.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { verifyAdmin, verifyOwner } from "../src/middleware/verifyRoles.js";
import { createVerifyTokenMiddleware } from "../src/middleware/verifyToken.js";
import { createAdminEquipmentController, createAdminRouter } from "../src/routes/admin.routes.js";
import { createEquipmentController, createEquipmentRouter } from "../src/routes/equipment.routes.js";
import { createAdminEquipmentService } from "../src/services/adminEquipment.service.js";
import { createEquipmentService } from "../src/services/equipment.service.js";

function evalCondition(doc, key, cond) {
  if (
    cond &&
    typeof cond === "object" &&
    !Array.isArray(cond) &&
    !(cond instanceof ObjectId) &&
    !(cond instanceof Date)
  ) {
    if ("$ne" in cond && doc[key] === cond.$ne) return false;
    if ("$gt" in cond && !(Number(doc[key]) > Number(cond.$gt))) return false;
    if ("$gte" in cond && !(Number(doc[key]) >= Number(cond.$gte))) return false;
    if ("$lte" in cond && !(Number(doc[key]) <= Number(cond.$lte))) return false;
    if ("$in" in cond && !cond.$in.some((v) => String(doc[key]) === String(v))) return false;
    if ("$regex" in cond) {
      const rx = new RegExp(cond.$regex, cond.$options || "");
      if (!rx.test(String(doc[key] || ""))) return false;
    }
    return true;
  }

  if (cond === null) return doc[key] === null;
  if (key === "_id" || key === "ownerId" || key === "equipmentId") {
    return String(doc[key]) === String(cond);
  }
  return doc[key] === cond;
}

function matchesFilter(doc, filter = {}) {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (Array.isArray(filter.$and) && !filter.$and.every((sub) => matchesFilter(doc, sub))) {
    return false;
  }
  if (Array.isArray(filter.$or) && !filter.$or.some((sub) => matchesFilter(doc, sub))) {
    return false;
  }
  for (const [key, val] of Object.entries(filter)) {
    if (key === "$and" || key === "$or") continue;
    if (!evalCondition(doc, key, val)) return false;
  }
  return true;
}

function createEquipmentStoreStub(rowsRef) {
  return {
    async findOne(filter) {
      return rowsRef.find((d) => matchesFilter(d, filter)) || null;
    },
    async countDocuments(filter = {}) {
      return rowsRef.filter((d) => matchesFilter(d, filter)).length;
    },
    find(filter = {}) {
      const matched = rowsRef.filter((d) => matchesFilter(d, filter));
      let sortSpec = null;
      let skipN = 0;
      let limitN = null;

      return {
        sort(spec) {
          sortSpec = spec;
          return this;
        },
        skip(n) {
          skipN = n;
          return this;
        },
        limit(n) {
          limitN = n;
          return this;
        },
        async toArray() {
          const out = [...matched];
          if (sortSpec) {
            out.sort((a, b) => {
              for (const [f, dir] of Object.entries(sortSpec)) {
                const avRaw = a[f];
                const bvRaw = b[f];
                const av =
                  avRaw instanceof Date
                    ? avRaw.getTime()
                    : typeof avRaw === "number"
                      ? avRaw
                      : String(avRaw || "");
                const bv =
                  bvRaw instanceof Date
                    ? bvRaw.getTime()
                    : typeof bvRaw === "number"
                      ? bvRaw
                      : String(bvRaw || "");
                if (av < bv) return dir === 1 ? -1 : 1;
                if (av > bv) return dir === 1 ? 1 : -1;
              }
              return 0;
            });
          }
          const end = limitN !== null ? skipN + limitN : out.length;
          return out.slice(skipN, end);
        },
      };
    },
    async findOneAndUpdate(filter, update) {
      const found = rowsRef.find((d) => matchesFilter(d, filter));
      if (!found) return null;
      if (update?.$set) Object.assign(found, update.$set);
      if (update?.$push) {
        for (const [arrKey, entry] of Object.entries(update.$push)) {
          if (!Array.isArray(found[arrKey])) found[arrKey] = [];
          found[arrKey].push(entry);
        }
      }
      return { ...found };
    },
    async updateOne(filter, update) {
      const found = rowsRef.find((d) => matchesFilter(d, filter));
      if (!found) return { modifiedCount: 0 };
      if (update?.$set) Object.assign(found, update.$set);
      return { modifiedCount: 1 };
    },
    async deleteOne(filter) {
      const idx = rowsRef.findIndex((d) => matchesFilter(d, filter));
      if (idx === -1) return { deletedCount: 0 };
      rowsRef.splice(idx, 1);
      return { deletedCount: 1 };
    },
  };
}

describe("Admin Equipment Moderation & Management APIs (Commit 13)", () => {
  let issuer;
  let jwksServer;
  let apiServer;
  let baseUrl;
  let privateKey;

  let usersDb = [];
  let equipmentDb = [];
  let bookingsDb = [];
  let paymentsDb = [];
  let favoritesDb = [];

  const adminId = new ObjectId().toString();
  const owner1Id = new ObjectId().toString();
  const owner2Id = "better-auth-owner-2";
  const customerId = new ObjectId().toString();

  const eqPendingId = new ObjectId();
  const eqApprovedNoHistoryId = new ObjectId();
  const eqApprovedBookedId = new ObjectId();
  const eqRejectedId = new ObjectId();

  let fixedNow = new Date("2026-11-22T15:30:00.000Z");

  async function signUserJwt(userId, role) {
    return new SignJWT({ role })
      .setProtectedHeader({ alg: "RS256", kid: "adm-eq-key-1" })
      .setIssuer(issuer)
      .setAudience(issuer)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("20m")
      .sign(privateKey);
  }

  before(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    publicJwk.kid = "adm-eq-key-1";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";

    jwksServer = http.createServer((req, res) => {
      if (req.url === "/api/auth/jwks") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    issuer = `http://127.0.0.1:${jwksServer.address().port}`;
    clearRemoteJWKSetCache();

    const verifyToken = createVerifyTokenMiddleware({
      usersCollectionGetter: async () => ({
        async findOne(filter) {
          return usersDb.find((u) => matchesFilter(u, filter)) || null;
        },
      }),
      verifyAccessToken: (token) =>
        verifyJwtAccessToken(token, {
          jwksUrl: `${issuer}/api/auth/jwks`,
          issuer,
          audience: issuer,
        }),
    });

    const equipmentStore = createEquipmentStoreStub(equipmentDb);

    const adminEquipmentService = createAdminEquipmentService({
      equipmentCollectionGetter: async () => equipmentStore,
      usersCollectionGetter: async () => createEquipmentStoreStub(usersDb),
      bookingsCollectionGetter: async () => createEquipmentStoreStub(bookingsDb),
      paymentsCollectionGetter: async () => createEquipmentStoreStub(paymentsDb),
      favoritesCollectionGetter: async () => ({
        async deleteMany(filter) {
          let deletedCount = 0;
          for (let i = favoritesDb.length - 1; i >= 0; i -= 1) {
            if (matchesFilter(favoritesDb[i], filter)) {
              favoritesDb.splice(i, 1);
              deletedCount += 1;
            }
          }
          return { deletedCount };
        },
      }),
      nowProvider: () => new Date(fixedNow.getTime()),
    });

    const publicEquipmentService = createEquipmentService({
      equipmentCollectionGetter: async () => equipmentStore,
      usersCollectionGetter: async () => createEquipmentStoreStub(usersDb),
      bookingsCollectionGetter: async () => createEquipmentStoreStub(bookingsDb),
      paymentsCollectionGetter: async () => createEquipmentStoreStub(paymentsDb),
      favoritesCollectionGetter: async () => ({
        async deleteMany() {
          return { deletedCount: 0 };
        },
      }),
    });

    const app = express();
    app.use(express.json());
    app.use(
      "/api/equipment",
      createEquipmentRouter({
        authMiddleware: verifyToken,
        ownerMiddleware: verifyOwner,
        controller: createEquipmentController(publicEquipmentService),
      })
    );
    app.use(
      "/api/admin",
      createAdminRouter({
        authMiddleware: verifyToken,
        adminMiddleware: verifyAdmin,
        equipmentController: createAdminEquipmentController(adminEquipmentService),
      })
    );
    app.use(errorHandler);

    apiServer = http.createServer(app);
    await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => jwksServer.close(resolve));
  });

  beforeEach(() => {
    usersDb.length = 0;
    equipmentDb.length = 0;
    bookingsDb.length = 0;
    paymentsDb.length = 0;
    favoritesDb.length = 0;

    usersDb.push(
      { _id: new ObjectId(adminId), name: "GearNest Admin", email: "admin@gearnest.test", passwordHash: "ADMIN_HASH", role: USER_ROLES.ADMIN },
      { _id: new ObjectId(owner1Id), name: "Alpha Heavy Rentals", email: "alpha@owner.test", image: "https://img/alpha.png", passwordHash: "OWNER_HASH", role: USER_ROLES.OWNER },
      { _id: owner2Id, id: owner2Id, name: "Karim Cinema Fleet", email: "karim@cinema.test", image: null, passwordHash: "OWNER_HASH", role: USER_ROLES.OWNER },
      { _id: new ObjectId(customerId), name: "Regular Renter", email: "renter@test.com", role: USER_ROLES.CUSTOMER }
    );

    equipmentDb.push(
      {
        _id: eqPendingId,
        name: "Caterpillar Bulldozer D6",
        description: "Heavy bulldozer submitted for marketplace moderation review.",
        category: "Construction Equipment",
        location: "Gazipur Yard",
        rentalPrice: 22000,
        rentalType: "Daily",
        availableQuantity: 2,
        condition: "Excellent",
        brand: "CAT",
        model: "D6K",
        image: "https://i.ibb.co/example/d6.jpg",
        rentalTerms: "Includes operator brief and safety check.",
        ownerId: owner1Id,
        status: EQUIPMENT_STATUSES.PENDING,
        createdAt: new Date("2026-11-22T10:00:00.000Z"),
        updatedAt: new Date("2026-11-22T10:00:00.000Z"),
      },
      {
        _id: eqApprovedNoHistoryId,
        name: "Sony FX3 Cinema Package",
        description: "Full-frame cinema camera package with prime lens set.",
        category: "Photography Equipment",
        location: "Gulshan Studio",
        rentalPrice: 4500,
        rentalType: "Daily",
        availableQuantity: 3,
        condition: "Like New",
        brand: "Sony",
        model: "FX3",
        image: "https://i.ibb.co/example/fx3.jpg",
        rentalTerms: "Valid studio deposit ID required.",
        ownerId: owner2Id,
        status: EQUIPMENT_STATUSES.APPROVED,
        reviewedBy: adminId,
        reviewedAt: new Date("2026-11-20T09:00:00.000Z"),
        createdAt: new Date("2026-11-19T10:00:00.000Z"),
        updatedAt: new Date("2026-11-20T09:00:00.000Z"),
      },
      {
        _id: eqApprovedBookedId,
        name: "Honda 100kVA Generator",
        description: "Commercial silent diesel generator for event & construction sites.",
        category: "Construction Equipment",
        location: "Uttara Depot",
        rentalPrice: 12000,
        rentalType: "Daily",
        availableQuantity: 4,
        condition: "Good",
        brand: "Honda",
        model: "100kVA",
        image: "https://i.ibb.co/example/gen.jpg",
        rentalTerms: "Minimum 24 hour commercial booking notice.",
        ownerId: owner1Id,
        status: EQUIPMENT_STATUSES.APPROVED,
        reviewedBy: adminId,
        reviewedAt: new Date("2026-11-18T11:00:00.000Z"),
        createdAt: new Date("2026-11-18T10:00:00.000Z"),
        updatedAt: new Date("2026-11-18T11:00:00.000Z"),
      },
      {
        _id: eqRejectedId,
        name: "Damaged Concrete Mixer",
        description: "Mixer submitted earlier with low resolution blurred image.",
        category: "Construction Equipment",
        location: "Narayanganj",
        rentalPrice: 1800,
        rentalType: "Daily",
        availableQuantity: 1,
        condition: "Fair",
        brand: "Generic",
        model: "M-200",
        image: "https://i.ibb.co/example/mixer.jpg",
        rentalTerms: "Standard site pick-up terms apply.",
        ownerId: owner1Id,
        status: EQUIPMENT_STATUSES.REJECTED,
        rejectionReason: "Listing photo must clearly show the serial plate.",
        reviewedBy: adminId,
        reviewedAt: new Date("2026-11-21T10:00:00.000Z"),
        createdAt: new Date("2026-11-21T08:00:00.000Z"),
        updatedAt: new Date("2026-11-21T10:00:00.000Z"),
      }
    );

    bookingsDb.push({
      _id: new ObjectId(),
      equipmentId: eqApprovedBookedId,
      customerId,
      ownerId: owner1Id,
      totalAmount: 24000,
      bookingStatus: "Confirmed",
    });

    paymentsDb.push({
      _id: new ObjectId(),
      equipmentId: eqApprovedBookedId,
      customerId,
      amount: 24000,
      status: "Paid",
    });

    favoritesDb.push(
      { _id: new ObjectId(), userId: customerId, equipmentId: eqApprovedNoHistoryId },
      { _id: new ObjectId(), userId: customerId, equipmentId: eqApprovedBookedId }
    );
  });

  test("AUTHORIZATION & ADMIN LISTING / SEARCH / FILTERS / SORTING / PAGINATION / DETAILS", async () => {
    const adminToken = await signUserJwt(adminId, USER_ROLES.ADMIN);
    const ownerToken = await signUserJwt(owner1Id, USER_ROLES.OWNER);
    const custToken = await signUserJwt(customerId, USER_ROLES.CUSTOMER);

    // 1. Unauthenticated, Customer & Owner denied across all Admin equipment endpoints
    for (const [method, path, body] of [
      ["GET", "/api/admin/equipment"],
      ["GET", `/api/admin/equipment/${eqPendingId.toString()}`],
      ["PATCH", `/api/admin/equipment/${eqPendingId.toString()}/approve`],
      ["PATCH", `/api/admin/equipment/${eqPendingId.toString()}/reject`, { reason: "No clear image" }],
      ["PATCH", `/api/admin/equipment/${eqPendingId.toString()}`, { name: "Updated Bulldozer" }],
      ["DELETE", `/api/admin/equipment/${eqPendingId.toString()}`],
    ]) {
      assert.equal((await fetch(`${baseUrl}${path}`, { method })).status, 401);
      for (const nonAdminToken of [ownerToken, custToken]) {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${nonAdminToken}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.equal(res.status, 403);
      }
    }

    // Stale JWT role after demotion in DB cannot pass verifyAdmin
    usersDb[0].role = USER_ROLES.OWNER;
    assert.equal(
      (
        await fetch(`${baseUrl}/api/admin/equipment`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).status,
      403
    );
    usersDb[0].role = USER_ROLES.ADMIN;

    // 2. Admin retrieves ALL statuses with safe owner join + summary breakdown + no secrets
    let res = await fetch(`${baseUrl}/api/admin/equipment`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 4);
    assert.deepEqual(json.summary, {
      total: 4,
      approved: 2,
      pending: 1,
      rejected: 1,
    });
    const pendingRow = json.data.find((d) => d._id === eqPendingId.toString());
    assert.equal(pendingRow.owner.name, "Alpha Heavy Rentals");
    assert.equal(pendingRow.owner.email, "alpha@owner.test");
    assert.equal(pendingRow.owner.passwordHash, undefined);

    // 3. Search by equipment name AND owner name/email + regex safety
    res = await fetch(`${baseUrl}/api/admin/equipment?search=Karim`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].name, "Sony FX3 Cinema Package");

    res = await fetch(
      `${baseUrl}/api/admin/equipment?category=${encodeURIComponent("Construction Equipment")}&status=Pending&sort=price_desc&page=1&limit=5`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0]._id, eqPendingId.toString());

    // 4. Sorting & pagination
    res = await fetch(`${baseUrl}/api/admin/equipment?sort=price_asc&page=2&limit=2`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 2);
    assert.equal(json.pagination.totalItems, 4);
    assert.equal(json.pagination.totalPages, 2);
    assert.equal(json.data[1].rentalPrice, 22000);

    // 5. Invalid filters rejected -> 400
    for (const bad of [
      "/api/admin/equipment?category=Invalid",
      "/api/admin/equipment?status=Archived",
      "/api/admin/equipment?sort=bad",
      "/api/admin/equipment?limit=51",
      "/api/admin/equipment?status[$ne]=Pending",
    ]) {
      assert.equal(
        (
          await fetch(`${baseUrl}${bad}`, {
            headers: { Authorization: `Bearer ${adminToken}` },
          })
        ).status,
        400
      );
    }

    // 6. Admin Equipment Details + audit info
    res = await fetch(`${baseUrl}/api/admin/equipment/${eqRejectedId.toString()}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.status, EQUIPMENT_STATUSES.REJECTED);
    assert.equal(
      json.data.rejectionReason,
      "Listing photo must clearly show the serial plate."
    );
    assert.equal(json.data.reviewedBy, adminId);
    assert.equal(json.data.owner.name, "Alpha Heavy Rentals");

    assert.equal(
      (
        await fetch(`${baseUrl}/api/admin/equipment/bad-id`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).status,
      400
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/admin/equipment/${new ObjectId().toString()}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).status,
      404
    );
  });

  test("APPROVE & REJECT EQUIPMENT: Audit trail, idempotency, public visibility & owner sync", async () => {
    const adminToken = await signUserJwt(adminId, USER_ROLES.ADMIN);
    const ownerToken = await signUserJwt(owner1Id, USER_ROLES.OWNER);

    // 1. Before approval: Pending item is NOT in public GET /api/equipment
    let pubRes = await fetch(`${baseUrl}/api/equipment`);
    let pubJson = await pubRes.json();
    assert.equal(
      pubJson.data.some((i) => i._id === eqPendingId.toString()),
      false
    );

    // 2. Approve Pending item -> status Approved, reviewedBy=adminId, clears rejectionReason, writes audit history
    let res = await fetch(
      `${baseUrl}/api/admin/equipment/${eqPendingId.toString()}/approve`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.status, EQUIPMENT_STATUSES.APPROVED);
    assert.equal(json.data.reviewedBy, adminId);
    assert.ok(json.data.reviewedAt);
    assert.equal(json.data.rejectionReason, null);
    assert.equal(json.data.approvalHistory.length, 1);
    assert.equal(json.data.approvalHistory[0].previousStatus, "Pending");

    // Repeated approval is idempotent without duplicating audit entries
    res = await fetch(
      `${baseUrl}/api/admin/equipment/${eqPendingId.toString()}/approve`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.approvalHistory.length, 1);

    // Now visible in public GET /api/equipment!
    pubRes = await fetch(`${baseUrl}/api/equipment`);
    pubJson = await pubRes.json();
    assert.ok(pubJson.data.some((i) => i._id === eqPendingId.toString()));

    // 3. Reject missing/empty reason fails -> 400
    for (const badBody of [{}, { reason: "   " }, { rejectionReason: "No" }]) {
      res = await fetch(
        `${baseUrl}/api/admin/equipment/${eqPendingId.toString()}/reject`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(badBody),
        }
      );
      assert.equal(res.status, 400);
    }

    // 4. Reject previously approved item using { reason } (also test { rejectionReason } later)
    res = await fetch(
      `${baseUrl}/api/admin/equipment/${eqPendingId.toString()}/reject`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reason: "Safety inspection certificate needs renewal.",
        }),
      }
    );
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.status, EQUIPMENT_STATUSES.REJECTED);
    assert.equal(
      json.data.rejectionReason,
      "Safety inspection certificate needs renewal."
    );
    assert.equal(json.data.approvalHistory.length, 2);

    // Immediately excluded from public catalog
    pubRes = await fetch(`${baseUrl}/api/equipment`);
    pubJson = await pubRes.json();
    assert.equal(
      pubJson.data.some((i) => i._id === eqPendingId.toString()),
      false
    );

    // Preserved in Owner's GET /api/equipment/my WITH rejectionReason!
    const myRes = await fetch(`${baseUrl}/api/equipment/my`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const myJson = await myRes.json();
    const ownerItem = myJson.data.find((i) => i._id === eqPendingId.toString());
    assert.equal(ownerItem.status, EQUIPMENT_STATUSES.REJECTED);
    assert.equal(
      ownerItem.rejectionReason,
      "Safety inspection certificate needs renewal."
    );

    // Repeated rejection with same reason is idempotent
    res = await fetch(
      `${baseUrl}/api/admin/equipment/${eqPendingId.toString()}/reject`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rejectionReason: "Safety inspection certificate needs renewal.",
        }),
      }
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.approvalHistory.length, 2);

    // Admin can re-approve a Rejected listing cleanly
    res = await fetch(
      `${baseUrl}/api/admin/equipment/${eqPendingId.toString()}/approve`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.status, EQUIPMENT_STATUSES.APPROVED);
    assert.equal(json.data.rejectionReason, null);
  });

  test("ADMIN UPDATE & SAFE ARCHIVAL / DELETE WITH BOOKING & PAYMENT PROTECTION", async () => {
    const adminToken = await signUserJwt(adminId, USER_ROLES.ADMIN);
    const ownerToken = await signUserJwt(owner1Id, USER_ROLES.OWNER);

    // 1. Admin updates permitted fields cleanly without changing ownerId or status
    let res = await fetch(
      `${baseUrl}/api/admin/equipment/${eqPendingId.toString()}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Caterpillar Bulldozer D6 (Inspected)",
          category: "Construction Equipment",
          rentalPrice: 24500,
          image: "https://i.ibb.co/example/d6-new.jpg",
          rentalTerms: "Updated verified safety compliance rental terms.",
        }),
      }
    );
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.name, "Caterpillar Bulldozer D6 (Inspected)");
    assert.equal(json.data.rentalPrice, 24500);
    assert.equal(json.data.ownerId, owner1Id);
    assert.equal(json.data.status, EQUIPMENT_STATUSES.PENDING);

    // 2. Reject invalid updates, ownerId tampering, approval status tampering & mass assignment -> 400
    for (const badPatch of [
      { rentalPrice: -100 },
      { category: "Invalid Category" },
      { ownerId: adminId },
      { status: "Approved" },
      { reviewedBy: adminId },
      { approvalHistory: [] },
      { arbitraryField: true },
    ]) {
      res = await fetch(
        `${baseUrl}/api/admin/equipment/${eqPendingId.toString()}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(badPatch),
        }
      );
      assert.equal(res.status, 400);
    }

    // 3. Delete equipment WITHOUT bookings/payments -> physical deletion + cleans favorites
    res = await fetch(
      `${baseUrl}/api/admin/equipment/${eqApprovedNoHistoryId.toString()}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.deleted, true);
    assert.equal(json.data.archived, false);
    assert.equal(
      equipmentDb.some((d) => String(d._id) === eqApprovedNoHistoryId.toString()),
      false
    );
    assert.equal(
      favoritesDb.some((f) => String(f.equipmentId) === eqApprovedNoHistoryId.toString()),
      false
    );

    // 4. Delete equipment WITH historical booking & payment records -> SAFE ARCHIVAL (isDeleted: true) preserving history!
    res = await fetch(
      `${baseUrl}/api/admin/equipment/${eqApprovedBookedId.toString()}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.deleted, false);
    assert.equal(json.data.archived, true);

    const archivedDoc = equipmentDb.find(
      (d) => String(d._id) === eqApprovedBookedId.toString()
    );
    assert.ok(archivedDoc);
    assert.equal(archivedDoc.isDeleted, true);
    assert.ok(archivedDoc.deletedAt instanceof Date);
    assert.equal(bookingsDb.length, 1); // Historical bookings preserved!
    assert.equal(paymentsDb.length, 1); // Historical payments preserved!
    assert.equal(
      favoritesDb.some((f) => String(f.equipmentId) === eqApprovedBookedId.toString()),
      false
    ); // Favorites cleaned!

    // Archived equipment excluded from public All, public Featured, Owner /my & Admin list!
    const [pubList, featList, ownerList, adminList] = await Promise.all([
      fetch(`${baseUrl}/api/equipment`).then((r) => r.json()),
      fetch(`${baseUrl}/api/equipment/featured`).then((r) => r.json()),
      fetch(`${baseUrl}/api/equipment/my`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }).then((r) => r.json()),
      fetch(`${baseUrl}/api/admin/equipment`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }).then((r) => r.json()),
    ]);

    for (const resp of [pubList, featList, ownerList, adminList]) {
      assert.equal(
        resp.data.some((d) => d._id === eqApprovedBookedId.toString()),
        false
      );
    }

    // Re-deleting already archived listing returns 404
    res = await fetch(
      `${baseUrl}/api/admin/equipment/${eqApprovedBookedId.toString()}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    assert.equal(res.status, 404);
  });
});
