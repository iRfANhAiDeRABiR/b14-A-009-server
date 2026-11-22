import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ObjectId } from "mongodb";

import {
  COLLECTION_INDEX_SPECS,
  ensureDatabaseCollectionsAndIndexes,
} from "../src/config/dbIndexes.js";
import { clearRemoteJWKSetCache, verifyJwtAccessToken } from "../src/config/jwks.js";
import { EQUIPMENT_STATUSES } from "../src/constants/equipment.js";
import { USER_ROLES } from "../src/constants/roles.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { verifyRenter } from "../src/middleware/verifyRoles.js";
import { createVerifyTokenMiddleware } from "../src/middleware/verifyToken.js";
import { COLLECTIONS, getFavoritesCollection } from "../src/models/collections.js";
import { createFavoriteController, createFavoriteRouter } from "../src/routes/favorite.routes.js";
import { createFavoriteService } from "../src/services/favorite.service.js";

function matchesFilter(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or") {
      if (!v.some((clause) => matchesFilter(doc, clause))) return false;
      continue;
    }
    if (doc[k] instanceof ObjectId || v instanceof ObjectId) {
      if (String(doc[k]) !== String(v)) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

function projectDoc(doc, projection) {
  if (!projection || Object.keys(projection).length === 0) return { ...doc };
  const projected = {};
  for (const [key, expr] of Object.entries(projection)) {
    if (expr === 1) {
      if (key in doc) projected[key] = doc[key];
    } else if (expr && typeof expr === "object") {
      const sourceObj = doc.equipmentDoc;
      if (sourceObj) {
        const sub = {};
        for (const subKey of Object.keys(expr)) {
          if (subKey in sourceObj) sub[subKey] = sourceObj[subKey];
        }
        projected[key] = sub;
      } else {
        projected[key] = undefined;
      }
    }
  }
  if (!("_id" in projected) && doc._id !== undefined) {
    projected._id = doc._id;
  }
  return projected;
}

function createFavoritesCollectionStub(rowsRef, equipmentRef, spyLog, { forceDuplicateOnce = false } = {}) {
  let simulateRaceDuplicate = forceDuplicateOnce;

  return {
    setSimulateRaceDuplicate(flag) {
      simulateRaceDuplicate = Boolean(flag);
    },
    async findOne(filter, options = {}) {
      if (simulateRaceDuplicate && options?.projection && Object.keys(options.projection).length === 1 && "_id" in options.projection && "equipmentId" in filter) {
        // Simulates two concurrent requests passing pre-insert check before hitting MongoDB unique index
        return null;
      }
      const found = rowsRef.find((doc) => matchesFilter(doc, filter));
      if (!found) return null;
      return options?.projection ? projectDoc(found, options.projection) : { ...found };
    },
    async insertOne(doc) {
      const duplicate = rowsRef.find(
        (existing) =>
          String(existing.userId) === String(doc.userId) &&
          String(existing.equipmentId) === String(doc.equipmentId)
      );
      if (duplicate) {
        const err = new Error(
          `E11000 duplicate key error collection: gearnest.favorites index: favorites_user_equipment_unique dup key`
        );
        err.code = 11000;
        err.keyPattern = { userId: 1, equipmentId: 1 };
        throw err;
      }
      const inserted = { ...doc, _id: doc._id || new ObjectId() };
      rowsRef.push(inserted);
      return { insertedId: inserted._id };
    },
    async countDocuments(filter = {}) {
      return rowsRef.filter((doc) => matchesFilter(doc, filter)).length;
    },
    async deleteOne(filter = {}) {
      spyLog?.push({ op: "deleteOne", filter });
      const idx = rowsRef.findIndex((doc) => matchesFilter(doc, filter));
      if (idx === -1) return { deletedCount: 0 };
      rowsRef.splice(idx, 1);
      return { deletedCount: 1 };
    },
    aggregate(pipeline = []) {
      spyLog?.push({ op: "aggregate", pipeline });
      return {
        async toArray() {
          let docs = rowsRef.map((d) => ({ ...d }));

          for (const stage of pipeline) {
            if (stage.$match) {
              docs = docs.filter((d) => matchesFilter(d, stage.$match));
            } else if (stage.$sort) {
              const entries = Object.entries(stage.$sort);
              docs.sort((a, b) => {
                for (const [field, dir] of entries) {
                  const av = a[field] instanceof Date ? a[field].getTime() : String(a[field] || "");
                  const bv = b[field] instanceof Date ? b[field].getTime() : String(b[field] || "");
                  if (av < bv) return dir === 1 ? -1 : 1;
                  if (av > bv) return dir === 1 ? 1 : -1;
                }
                return 0;
              });
            } else if (typeof stage.$skip === "number") {
              docs = docs.slice(stage.$skip);
            } else if (typeof stage.$limit === "number") {
              docs = docs.slice(0, stage.$limit);
            } else if (stage.$lookup) {
              const { localField, foreignField, as } = stage.$lookup;
              docs = docs.map((d) => ({
                ...d,
                [as]: equipmentRef.filter(
                  (eq) => String(eq[foreignField]) === String(d[localField])
                ),
              }));
            } else if (stage.$unwind) {
              const field = String(stage.$unwind.path || "").replace(/^\$/, "");
              const preserve = Boolean(stage.$unwind.preserveNullAndEmptyArrays);
              docs = docs.flatMap((d) => {
                const arr = d[field] || [];
                if (arr.length === 0) {
                  return preserve ? [{ ...d, [field]: undefined }] : [];
                }
                return arr.map((entry) => ({ ...d, [field]: entry }));
              });
            } else if (stage.$project) {
              docs = docs.map((d) => projectDoc(d, stage.$project));
            }
          }

          return docs;
        },
      };
    },
  };
}

describe("Customer Favorites API System (Commit 08)", () => {
  let issuer;
  let jwksServer;
  let apiServer;
  let baseUrl;
  let privateKey;

  let usersDb = [];
  let equipmentDb = [];
  let favoritesDb = [];
  let bookingsDb = [];
  let spyOps = [];
  let favoritesStub;

  const customerAId = new ObjectId().toString();
  const customerBId = "better-auth-customer-b-string-id";
  const ownerId = new ObjectId().toString();
  const adminId = new ObjectId().toString();

  const approvedInStockId = new ObjectId();
  const approvedOutOfStockId = new ObjectId();
  const approvedOtherId = new ObjectId();
  const pendingEquipmentId = new ObjectId();
  const rejectedEquipmentId = new ObjectId();

  async function signUserJwt(userId, role = USER_ROLES.CUSTOMER) {
    return new SignJWT({ role })
      .setProtectedHeader({ alg: "RS256", kid: "fav-key-1" })
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
    publicJwk.kid = "fav-key-1";
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

    const app = express();
    app.use(express.json());

    favoritesStub = createFavoritesCollectionStub(
      favoritesDb,
      equipmentDb,
      spyOps
    );

    const service = createFavoriteService({
      favoritesCollectionGetter: async () => favoritesStub,
      equipmentCollectionGetter: async () => ({
        async findOne(filter, options = {}) {
          const found = equipmentDb.find((d) => matchesFilter(d, filter));
          if (!found) return null;
          return options?.projection
            ? projectDoc(found, options.projection)
            : { ...found };
        },
      }),
    });

    app.use(
      "/api/favorites",
      createFavoriteRouter({
        authMiddleware: verifyToken,
        renterMiddleware: verifyRenter,
        controller: createFavoriteController(service),
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
    favoritesDb.length = 0;
    bookingsDb.length = 0;
    spyOps.length = 0;
    favoritesStub.setSimulateRaceDuplicate(false);

    usersDb.push(
      { _id: new ObjectId(customerAId), name: "Customer A", email: "a@test.com", role: USER_ROLES.CUSTOMER },
      { _id: customerBId, id: customerBId, name: "Customer B", email: "b@test.com", role: USER_ROLES.CUSTOMER },
      { _id: new ObjectId(ownerId), name: "Owner", email: "o@test.com", role: USER_ROLES.OWNER },
      { _id: new ObjectId(adminId), name: "Admin", email: "adm@test.com", role: USER_ROLES.ADMIN }
    );

    equipmentDb.push(
      {
        _id: approvedInStockId,
        name: "CAT Mini Excavator 302",
        description: "Private internal spec description not needed in favorites",
        category: "Construction Equipment",
        location: "Dhaka Depot",
        rentalPrice: 9500,
        rentalType: "Daily",
        availableQuantity: 4,
        image: "https://i.ibb.co/example/excavator.jpg",
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.APPROVED,
      },
      {
        _id: approvedOtherId,
        name: "Sony FX3 Cinema Kit",
        category: "Photography Equipment",
        location: "Gulshan Studio",
        rentalPrice: 4200,
        rentalType: "Daily",
        availableQuantity: 2,
        image: "https://i.ibb.co/example/fx3.jpg",
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.APPROVED,
      },
      {
        _id: approvedOutOfStockId,
        name: "Honda 20kVA Generator",
        category: "Construction Equipment",
        location: "Chittagong Yard",
        rentalPrice: 7000,
        rentalType: "Weekly",
        availableQuantity: 0,
        image: "https://i.ibb.co/example/gen.jpg",
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.APPROVED,
      },
      {
        _id: pendingEquipmentId,
        name: "Secret Unapproved Drone",
        category: "Electronics",
        location: "Secret Hangar 9",
        rentalPrice: 12000,
        rentalType: "Daily",
        availableQuantity: 3,
        image: "https://i.ibb.co/example/secret.jpg",
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.PENDING,
      },
      {
        _id: rejectedEquipmentId,
        name: "Defective Concrete Mixer",
        category: "Construction Equipment",
        location: "Reject Lot",
        rentalPrice: 3000,
        rentalType: "Daily",
        availableQuantity: 1,
        image: "https://i.ibb.co/example/reject.jpg",
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.REJECTED,
      }
    );

    bookingsDb.push({
      _id: new ObjectId(),
      equipmentId: approvedInStockId,
      customerId: customerAId,
      bookingStatus: "Completed",
    });
  });

  test("AUTHORIZATION: Unauthenticated, Owner & Admin rejected; Customer authorized", async () => {
    const idStr = approvedInStockId.toString();

    // Unauthenticated rejected -> 401
    for (const [method, path, body] of [
      ["GET", "/api/favorites"],
      ["POST", "/api/favorites", { equipmentId: idStr }],
      ["GET", `/api/favorites/${idStr}/status`],
      ["DELETE", `/api/favorites/${idStr}`],
    ]) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).message, "Authentication required");
    }

    // Owner and Admin rejected -> 403 Customer access required
    for (const token of [
      await signUserJwt(ownerId, USER_ROLES.OWNER),
      await signUserJwt(adminId, USER_ROLES.ADMIN),
    ]) {
      for (const [method, path, body] of [
        ["GET", "/api/favorites"],
        ["POST", "/api/favorites", { equipmentId: idStr }],
        ["GET", `/api/favorites/${idStr}/status`],
        ["DELETE", `/api/favorites/${idStr}`],
      ]) {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).message, "Customer access required");
      }
    }

    // Customer authorized cleanly
    const customerToken = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);
    const getRes = await fetch(`${baseUrl}/api/favorites`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert.equal(getRes.status, 200);
    const getJson = await getRes.json();
    assert.equal(getJson.success, true);
    assert.deepEqual(getJson.data, []);
  });

  test("ADD FAVORITE: Approved creation, duplicate idempotency, E11000 concurrency, validation & approval blocks", async () => {
    const tokenA = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);
    const tokenB = await signUserJwt(customerBId, USER_ROLES.CUSTOMER);

    // 1. Add Approved item + test spoofed req.body.userId is ignored cleanly
    const addRes = await fetch(`${baseUrl}/api/favorites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        equipmentId: approvedInStockId.toString(),
        userId: customerBId,
      }),
    });
    const addJson = await addRes.json();
    assert.equal(addRes.status, 201);
    assert.equal(addJson.success, true);
    assert.equal(addJson.message, "Equipment added to favorites successfully");
    assert.deepEqual(addJson.data, {
      equipmentId: approvedInStockId.toString(),
      isFavorite: true,
    });

    // Stored document references only userId, ObjectId equipmentId, createdAt
    assert.equal(favoritesDb.length, 1);
    assert.equal(favoritesDb[0].userId, customerAId);
    assert.ok(favoritesDb[0].equipmentId instanceof ObjectId);
    assert.ok(favoritesDb[0].createdAt instanceof Date);
    assert.equal(favoritesDb[0].name, undefined);
    assert.equal(favoritesDb[0].rentalPrice, undefined);

    // 2. Duplicate POST returns idempotent 200 without duplicating row
    const dupRes = await fetch(`${baseUrl}/api/favorites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ equipmentId: approvedInStockId.toString() }),
    });
    const dupJson = await dupRes.json();
    assert.equal(dupRes.status, 200);
    assert.equal(dupJson.data.isFavorite, true);
    assert.equal(favoritesDb.length, 1);

    // 3. Different Customer B can favorite the exact same equipment
    const bRes = await fetch(`${baseUrl}/api/favorites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ equipmentId: approvedInStockId.toString() }),
    });
    assert.equal(bRes.status, 201);
    assert.equal(favoritesDb.length, 2);
    assert.equal(favoritesDb[1].userId, customerBId);

    // 4. Concurrent duplicate race triggering unique index E11000 is handled safely
    favoritesStub.setSimulateRaceDuplicate(true);
    const [race1, race2] = await Promise.all([
      fetch(`${baseUrl}/api/favorites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ equipmentId: approvedOtherId.toString() }),
      }),
      fetch(`${baseUrl}/api/favorites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ equipmentId: approvedOtherId.toString() }),
      }),
    ]);
    favoritesStub.setSimulateRaceDuplicate(false);
    const statuses = [race1.status, race2.status].sort();
    assert.deepEqual(statuses, [200, 201]);
    assert.equal(
      favoritesDb.filter(
        (d) =>
          d.userId === customerAId &&
          String(d.equipmentId) === approvedOtherId.toString()
      ).length,
      1
    );

    // 5. Pending, Rejected, nonexistent, invalid ObjectId, missing field & malformed body
    for (const [payload, expectedStatus] of [
      [{ equipmentId: pendingEquipmentId.toString() }, 400],
      [{ equipmentId: rejectedEquipmentId.toString() }, 400],
      [{ equipmentId: new ObjectId().toString() }, 404],
      [{ equipmentId: "invalid-id" }, 400],
      [{}, 400],
      [["not-an-object"], 400],
    ]) {
      const badRes = await fetch(`${baseUrl}/api/favorites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      assert.equal(badRes.status, expectedStatus);
      const errJson = await badRes.json();
      assert.equal(errJson.success, false);
    }
  });

  test("GET FAVORITES: $lookup projection, sort order, isolation, availability, hidden status, deleted & pagination", async () => {
    const tokenA = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);
    const deletedId = new ObjectId();

    // Seed Customer A & Customer B favorites directly with controlled timestamps
    favoritesDb.push(
      {
        _id: new ObjectId(),
        userId: customerAId,
        equipmentId: approvedInStockId,
        createdAt: new Date("2026-01-01T10:00:00Z"),
      },
      {
        _id: new ObjectId(),
        userId: customerAId,
        equipmentId: approvedOutOfStockId,
        createdAt: new Date("2026-01-02T10:00:00Z"),
      },
      {
        _id: new ObjectId(),
        userId: customerAId,
        equipmentId: approvedOtherId,
        createdAt: new Date("2026-01-05T10:00:00Z"), // newest
      },
      {
        _id: new ObjectId(),
        userId: customerAId,
        equipmentId: pendingEquipmentId, // later changed to Pending
        createdAt: new Date("2026-01-03T10:00:00Z"),
      },
      {
        _id: new ObjectId(),
        userId: customerAId,
        equipmentId: rejectedEquipmentId, // later changed to Rejected
        createdAt: new Date("2026-01-04T10:00:00Z"),
      },
      {
        _id: new ObjectId(),
        userId: customerAId,
        equipmentId: deletedId, // orphaned after equipment delete
        createdAt: new Date("2025-12-31T10:00:00Z"), // oldest
      },
      {
        _id: new ObjectId(),
        userId: customerBId,
        equipmentId: approvedInStockId,
        createdAt: new Date("2026-01-06T10:00:00Z"),
      }
    );

    const res = await fetch(`${baseUrl}/api/favorites`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 6); // strictly Customer A's rows

    // Aggregation query binds strictly to req.user.id & runs $lookup
    const aggSpy = spyOps.find((s) => s.op === "aggregate");
    assert.equal(aggSpy.pipeline[0].$match.userId, customerAId);
    assert.ok(aggSpy.pipeline.some((s) => s.$lookup?.from === COLLECTIONS.EQUIPMENT));

    // Sorted newest first
    assert.equal(json.data[0].equipmentId, approvedOtherId.toString());
    assert.equal(json.data[0].name, "Sony FX3 Cinema Kit");
    assert.equal(json.data[0].rentalPrice, 4200);
    assert.equal(json.data[0].rentalType, "Daily");
    assert.equal(json.data[0].location, "Gulshan Studio");
    assert.equal(json.data[0].availabilityStatus, "Available");
    assert.equal(json.data[0].isAvailable, true);
    assert.equal(json.data[0].description, undefined);

    // Rejected & Pending listings never leak private details
    const rejectedItem = json.data.find(
      (i) => i.equipmentId === rejectedEquipmentId.toString()
    );
    assert.equal(rejectedItem.name, "Unavailable Listing");
    assert.equal(rejectedItem.location, "");
    assert.equal(rejectedItem.rentalPrice, null);
    assert.equal(rejectedItem.isListingHidden, true);
    assert.equal(rejectedItem.isAvailable, false);

    const pendingItem = json.data.find(
      (i) => i.equipmentId === pendingEquipmentId.toString()
    );
    assert.equal(pendingItem.name, "Unavailable Listing");
    assert.equal(pendingItem.location, "");
    assert.equal(pendingItem.rentalPrice, null);
    assert.equal(pendingItem.isListingHidden, true);

    // Approved zero-quantity remains visible as Unavailable
    const zeroQtyItem = json.data.find(
      (i) => i.equipmentId === approvedOutOfStockId.toString()
    );
    assert.equal(zeroQtyItem.name, "Honda 20kVA Generator");
    assert.equal(zeroQtyItem.availableQuantity, 0);
    assert.equal(zeroQtyItem.availabilityStatus, "Unavailable");
    assert.equal(zeroQtyItem.isAvailable, false);

    // Deleted orphaned favorite handled cleanly without crashing
    const orphaned = json.data.find((i) => i.equipmentId === deletedId.toString());
    assert.equal(orphaned.name, "Equipment No Longer Listed");
    assert.equal(orphaned.availabilityStatus, "Unavailable (Removed)");
    assert.equal(orphaned.isDeleted, true);
    assert.equal(orphaned.equipmentDeleted, true);

    // Optional server-side pagination works without breaking default contract
    const pagedRes = await fetch(`${baseUrl}/api/favorites?page=2&limit=2`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const pagedJson = await pagedRes.json();
    assert.equal(pagedRes.status, 200);
    assert.equal(pagedJson.data.length, 2);
    assert.deepEqual(pagedJson.pagination, {
      currentPage: 2,
      limit: 2,
      totalItems: 6,
      totalPages: 3,
    });

    const badPage = await fetch(`${baseUrl}/api/favorites?limit=0`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(badPage.status, 400);
  });

  test("STATUS, REMOVE & ISOLATION: Status checks, deletion safety, intact equipment/bookings & DB index specs", async () => {
    const tokenA = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);

    favoritesDb.push(
      {
        _id: new ObjectId(),
        userId: customerAId,
        equipmentId: approvedInStockId,
        createdAt: new Date(),
      },
      {
        _id: new ObjectId(),
        userId: customerBId,
        equipmentId: approvedOtherId,
        createdAt: new Date(),
      }
    );

    // Existing own favorite status -> true
    let res = await fetch(
      `${baseUrl}/api/favorites/${approvedInStockId.toString()}/status`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(json.data, {
      equipmentId: approvedInStockId.toString(),
      isFavorite: true,
    });

    // Item saved ONLY by Customer B reports isFavorite: false to Customer A
    res = await fetch(
      `${baseUrl}/api/favorites/${approvedOtherId.toString()}/status`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(json.data, {
      equipmentId: approvedOtherId.toString(),
      isFavorite: false,
    });

    // Invalid ID on status -> 400
    res = await fetch(`${baseUrl}/api/favorites/not-an-id/status`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 400);

    // Customer A cannot remove Customer B's favorite -> 404 & row preserved
    res = await fetch(`${baseUrl}/api/favorites/${approvedOtherId.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).message, "Favorite not found");
    assert.ok(
      favoritesDb.some(
        (d) =>
          d.userId === customerBId &&
          String(d.equipmentId) === approvedOtherId.toString()
      )
    );

    // Invalid ID on delete -> 400
    res = await fetch(`${baseUrl}/api/favorites/bad-id`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 400);

    // Remove own favorite -> 200; equipment & bookings remain untouched
    res = await fetch(`${baseUrl}/api/favorites/${approvedInStockId.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.message, "Equipment removed from favorites successfully");
    assert.deepEqual(json.data, {
      equipmentId: approvedInStockId.toString(),
      isFavorite: false,
    });
    assert.equal(
      favoritesDb.some((d) => d.userId === customerAId),
      false
    );
    assert.ok(
      equipmentDb.some((e) => String(e._id) === approvedInStockId.toString())
    );
    assert.equal(bookingsDb.length, 1);

    // Removing again returns 404
    res = await fetch(`${baseUrl}/api/favorites/${approvedInStockId.toString()}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 404);

    // Verify database collection reuse & idempotent unique index definitions
    const stubCollectionName = [];
    getFavoritesCollection({
      collection(name) {
        stubCollectionName.push(name);
        return {};
      },
    });
    assert.deepEqual(stubCollectionName, [COLLECTIONS.FAVORITES]);

    const favSpecs = COLLECTION_INDEX_SPECS[COLLECTIONS.FAVORITES];
    assert.ok(
      favSpecs.some(
        (s) =>
          JSON.stringify(s.key) === JSON.stringify({ userId: 1, equipmentId: 1 }) &&
          s.options?.unique === true
      )
    );

    const createdIndexes = {};
    const mockDb = {
      listCollections: () => ({
        async toArray() {
          return Object.values(COLLECTIONS).map((name) => ({ name }));
        },
      }),
      collection(name) {
        createdIndexes[name] = createdIndexes[name] || [];
        return {
          listIndexes: () => ({
            async toArray() {
              return createdIndexes[name];
            },
          }),
          async createIndex(key, options) {
            const isText = Object.values(key).includes("text");
            createdIndexes[name].push({
              key: isText ? { _fts: "text", _ftsx: 1 } : key,
              ...options,
            });
          },
        };
      },
    };
    const firstRun = await ensureDatabaseCollectionsAndIndexes(mockDb);
    const secondRun = await ensureDatabaseCollectionsAndIndexes(mockDb);
    assert.ok(firstRun.indexesCreated > 0);
    assert.equal(secondRun.indexesCreated, 0);
    assert.equal(secondRun.indexesSkipped, firstRun.indexesCreated);
  });
});
