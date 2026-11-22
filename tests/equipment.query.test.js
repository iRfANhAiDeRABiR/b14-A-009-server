import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ObjectId } from "mongodb";

import { clearRemoteJWKSetCache, verifyJwtAccessToken } from "../src/config/jwks.js";
import { EQUIPMENT_CATEGORIES, EQUIPMENT_STATUSES } from "../src/constants/equipment.js";
import { USER_ROLES } from "../src/constants/roles.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { verifyOwner } from "../src/middleware/verifyRoles.js";
import { createVerifyTokenMiddleware } from "../src/middleware/verifyToken.js";
import { createEquipmentController, createEquipmentRouter } from "../src/routes/equipment.routes.js";
import { createEquipmentService } from "../src/services/equipment.service.js";
import { buildPublicEquipmentMongoQuery } from "../src/utils/equipmentQuery.js";

function evalCondition(doc, key, cond) {
  if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof ObjectId)) {
    if ("$gt" in cond && !(Number(doc[key]) > Number(cond.$gt))) return false;
    if ("$gte" in cond && !(Number(doc[key]) >= Number(cond.$gte))) return false;
    if ("$lte" in cond) {
      if (doc[key] === undefined || doc[key] === null || !(Number(doc[key]) <= Number(cond.$lte))) {
        return false;
      }
    }
    if ("$exists" in cond) {
      const exists = key in doc && doc[key] !== undefined;
      if (Boolean(cond.$exists) !== exists) return false;
    }
    if ("$in" in cond && !cond.$in.some((v) => String(doc[key]) === String(v))) return false;
    if ("$ne" in cond && doc[key] === cond.$ne) return false;
    if ("$regex" in cond) {
      const rx = new RegExp(cond.$regex, cond.$options || "");
      if (!rx.test(String(doc[key] || ""))) return false;
    }
    return true;
  }

  if (cond === null) {
    return doc[key] === null;
  }
  if (key === "_id" || key === "ownerId" || key === "equipmentId") {
    return String(doc[key]) === String(cond);
  }
  return doc[key] === cond;
}

function matchesMongoFilter(doc, filter = {}) {
  if (!filter || Object.keys(filter).length === 0) return true;

  if (Array.isArray(filter.$and)) {
    if (!filter.$and.every((sub) => matchesMongoFilter(doc, sub))) return false;
  }
  if (Array.isArray(filter.$or)) {
    if (!filter.$or.some((sub) => matchesMongoFilter(doc, sub))) return false;
  }

  for (const [key, val] of Object.entries(filter)) {
    if (key === "$and" || key === "$or") continue;
    if (!evalCondition(doc, key, val)) return false;
  }
  return true;
}

function createQueryableCollectionStub(rowsRef, spyOps) {
  return {
    async findOne(filter) {
      return rowsRef.find((d) => matchesMongoFilter(d, filter)) || null;
    },
    async countDocuments(filter = {}) {
      spyOps.push({ op: "countDocuments", filter });
      return rowsRef.filter((d) => matchesMongoFilter(d, filter)).length;
    },
    find(filter = {}) {
      spyOps.push({ op: "find", filter });
      let matched = rowsRef.filter((d) => matchesMongoFilter(d, filter));
      let sortSpec = null;
      let skipN = 0;
      let limitN = null;

      return {
        sort(spec) {
          sortSpec = spec;
          spyOps.push({ op: "sort", sort: spec });
          return this;
        },
        skip(n) {
          skipN = n;
          spyOps.push({ op: "skip", skip: n });
          return this;
        },
        limit(n) {
          limitN = n;
          spyOps.push({ op: "limit", limit: n });
          return this;
        },
        async toArray() {
          const out = [...matched];
          if (sortSpec) {
            out.sort((a, b) => {
              for (const [field, dir] of Object.entries(sortSpec)) {
                const va =
                  a[field] instanceof Date
                    ? a[field].getTime()
                    : field === "rentalPrice"
                      ? Number(a[field])
                      : String(a[field] || "");
                const vb =
                  b[field] instanceof Date
                    ? b[field].getTime()
                    : field === "rentalPrice"
                      ? Number(b[field])
                      : String(b[field] || "");
                if (va < vb) return dir === 1 ? -1 : 1;
                if (va > vb) return dir === 1 ? 1 : -1;
              }
              return 0;
            });
          }
          const end = limitN !== null ? skipN + limitN : out.length;
          return out.slice(skipN, end);
        },
      };
    },
  };
}

describe("Equipment Search, Filtering, Sorting & Pagination (Commit 07)", () => {
  const issuer = "http://127.0.0.1:5907";
  const audience = "http://127.0.0.1:5907";

  let keyPair;
  let jwksServer;
  let jwksUrl;
  let apiServer;
  let baseUrl;

  let equipmentRows = [];
  let usersRows = [];
  const spyOps = [];

  const ownerId = "owner_query_01";

  async function mintOwnerJwt() {
    return new SignJWT({ role: USER_ROLES.OWNER })
      .setProtectedHeader({ alg: "EdDSA", kid: "commit07-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(ownerId)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(keyPair.privateKey);
  }

  function seedDataset() {
    const baseItem = {
      description: "Commercial rental equipment verified for deployment.",
      condition: "Excellent",
      brand: "GearPro",
      model: "GP-1",
      image: "https://i.ibb.co/example/item.jpg",
      rentalTerms: "Standard return inspection applies.",
      ownerId,
    };

    equipmentRows = [
      {
        ...baseItem,
        _id: new ObjectId("650000000000000000000001"),
        name: "CAT Mini Excavator 302",
        category: "Construction Equipment",
        location: "Gazipur, Bangladesh",
        rentalPrice: 8500,
        rentalType: "Daily",
        availableQuantity: 3,
        status: EQUIPMENT_STATUSES.APPROVED,
        createdAt: new Date("2026-10-01T10:00:00Z"),
        updatedAt: new Date("2026-10-01T10:00:00Z"),
      },
      {
        ...baseItem,
        _id: new ObjectId("650000000000000000000002"),
        name: "Sony FX6 Cinema Camera Kit",
        title: "Full-Frame Cinema Production Rig",
        category: "Photography Equipment",
        location: "Banani, Dhaka",
        rentalPrice: 4500,
        rentalType: "Daily",
        availableQuantity: 2,
        status: EQUIPMENT_STATUSES.APPROVED,
        createdAt: new Date("2026-10-03T10:00:00Z"),
        updatedAt: new Date("2026-10-03T10:00:00Z"),
      },
      {
        ...baseItem,
        _id: new ObjectId("650000000000000000000003"),
        name: "Isuzu Flatbed Cargo Truck",
        category: "Vehicles & Transportation",
        location: "Chittagong Port",
        rentalPrice: 28000,
        rentalType: "Weekly",
        availableQuantity: 1,
        status: EQUIPMENT_STATUSES.APPROVED,
        createdAt: new Date("2026-10-05T10:00:00Z"),
        updatedAt: new Date("2026-10-05T10:00:00Z"),
      },
      {
        ...baseItem,
        _id: new ObjectId("650000000000000000000004"),
        name: "John Deere Utility Tractor",
        category: "Agriculture Equipment",
        location: "Rajshahi",
        rentalPrice: 65000,
        rentalType: "Monthly",
        availableQuantity: 0,
        status: EQUIPMENT_STATUSES.APPROVED,
        createdAt: new Date("2026-10-07T10:00:00Z"),
        updatedAt: new Date("2026-10-07T10:00:00Z"),
      },
      {
        ...baseItem,
        _id: new ObjectId("650000000000000000000005"),
        name: "EcoFlow Pro Portable Generator",
        category: "Electronics",
        location: "Mirpur, Dhaka",
        rentalPrice: 3200,
        rentalType: "Daily",
        availableQuantity: 5,
        status: EQUIPMENT_STATUSES.APPROVED,
        createdAt: new Date("2026-10-09T10:00:00Z"),
        updatedAt: new Date("2026-10-09T10:00:00Z"),
      },
      {
        ...baseItem,
        _id: new ObjectId("650000000000000000000006"),
        name: "JBL Line Array Event PA System",
        category: "Event Equipment",
        location: "Gulshan, Dhaka",
        rentalPrice: 14000,
        rentalType: "Weekly",
        availableQuantity: 0,
        status: EQUIPMENT_STATUSES.APPROVED,
        createdAt: new Date("2026-10-11T10:00:00Z"),
        updatedAt: new Date("2026-10-11T10:00:00Z"),
      },
      {
        ...baseItem,
        _id: new ObjectId("650000000000000000000007"),
        name: "Bosch [2026]* Special Drill",
        category: "Construction Equipment",
        location: "Gazipur, Bangladesh",
        rentalPrice: 3200, // intentional price tie with EcoFlow for stable sort verification
        rentalType: "Daily",
        availableQuantity: 4,
        status: EQUIPMENT_STATUSES.APPROVED,
        createdAt: new Date("2026-10-13T10:00:00Z"),
        updatedAt: new Date("2026-10-13T10:00:00Z"),
      },
      {
        ...baseItem,
        _id: new ObjectId("650000000000000000000008"),
        name: "Pending Excavator Listing",
        category: "Construction Equipment",
        location: "Gazipur, Bangladesh",
        rentalPrice: 5000,
        rentalType: "Daily",
        availableQuantity: 2,
        status: EQUIPMENT_STATUSES.PENDING,
        createdAt: new Date("2026-11-01T10:00:00Z"),
        updatedAt: new Date("2026-11-01T10:00:00Z"),
      },
      {
        ...baseItem,
        _id: new ObjectId("650000000000000000000009"),
        name: "Rejected Drone Package",
        category: "Photography Equipment",
        location: "Dhaka",
        rentalPrice: 2000,
        rentalType: "Daily",
        availableQuantity: 1,
        status: EQUIPMENT_STATUSES.REJECTED,
        createdAt: new Date("2026-11-02T10:00:00Z"),
        updatedAt: new Date("2026-11-02T10:00:00Z"),
      },
    ];
  }

  before(async () => {
    keyPair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const jwk = await exportJWK(keyPair.publicKey);
    jwk.kid = "commit07-key";
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

    const verifyTokenMiddleware = createVerifyTokenMiddleware({
      usersCollectionGetter: () => createQueryableCollectionStub(usersRows, spyOps),
      verifyAccessToken: (token) =>
        verifyJwtAccessToken(token, { jwksUrl, issuer, audience }),
    });

    const eqService = createEquipmentService({
      equipmentCollectionGetter: () =>
        createQueryableCollectionStub(equipmentRows, spyOps),
      usersCollectionGetter: () => createQueryableCollectionStub(usersRows, spyOps),
    });

    const app = express();
    app.use(express.json());
    app.use(
      "/api/equipment",
      createEquipmentRouter({
        authMiddleware: verifyTokenMiddleware,
        ownerMiddleware: verifyOwner,
        controller: createEquipmentController(eqService),
      })
    );
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
    spyOps.length = 0;
    usersRows = [
      {
        _id: ownerId,
        id: ownerId,
        name: "GearOwner",
        email: "private-owner@example.com",
        passwordHash: "PRIVATE_SECRET_HASH",
        phone: "01700000000",
        image: null,
        role: USER_ROLES.OWNER,
      },
    ];
    seedDataset();
  });

  test("SEARCH TESTS: name, title, location, category, whitespace, case-insensitivity, regex escaping & length", async () => {
    // Search by name (case-insensitive)
    let res = await fetch(`${baseUrl}/api/equipment?search=excavator`);
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].name, "CAT Mini Excavator 302");

    // Search by optional title field
    res = await fetch(`${baseUrl}/api/equipment?search=Full-Frame`);
    json = await res.json();
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].name, "Sony FX6 Cinema Camera Kit");

    // Search by location with surrounding whitespace
    res = await fetch(`${baseUrl}/api/equipment?search=${encodeURIComponent("  gazipur  ")}`);
    json = await res.json();
    assert.equal(json.data.length, 2);

    // Search by category substring
    res = await fetch(`${baseUrl}/api/equipment?search=Agriculture`);
    json = await res.json();
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].category, "Agriculture Equipment");

    // Empty search returns all Approved items (7)
    res = await fetch(`${baseUrl}/api/equipment?search=${encodeURIComponent("   ")}`);
    json = await res.json();
    assert.equal(json.pagination.totalItems, 7);

    // Regex metacharacters escaped safely (`[2026]*` matches literal item, `.*` matches 0!)
    res = await fetch(`${baseUrl}/api/equipment?search=${encodeURIComponent("[2026]*")}`);
    json = await res.json();
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].name, "Bosch [2026]* Special Drill");

    res = await fetch(`${baseUrl}/api/equipment?search=${encodeURIComponent(".*")}`);
    json = await res.json();
    assert.equal(json.data.length, 0);
    assert.equal(json.message, "No matching equipment found");

    // Overly long search (>120 chars) rejected -> 400
    res = await fetch(`${baseUrl}/api/equipment?search=${"a".repeat(121)}`);
    assert.equal(res.status, 400);
  });

  test("CATEGORY, RENTAL TYPE, PRICE & AVAILABILITY FILTERS", async () => {
    // All 6 categories work cleanly
    for (const category of EQUIPMENT_CATEGORIES) {
      const res = await fetch(
        `${baseUrl}/api/equipment?category=${encodeURIComponent(category)}`
      );
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.ok(json.data.length >= 1);
      assert.ok(json.data.every((item) => item.category === category));
    }

    // Invalid category -> 400
    let badRes = await fetch(`${baseUrl}/api/equipment?category=InvalidCat`);
    assert.equal(badRes.status, 400);
    assert.equal((await badRes.json()).message, "Invalid equipment category");

    // Rental types: Daily, Weekly, Monthly
    for (const [rentalType, expectedCount] of [
      ["Daily", 4],
      ["Weekly", 2],
      ["Monthly", 1],
    ]) {
      const res = await fetch(`${baseUrl}/api/equipment?rentalType=${rentalType}`);
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.pagination.totalItems, expectedCount);
    }

    badRes = await fetch(`${baseUrl}/api/equipment?rentalType=Yearly`);
    assert.equal(badRes.status, 400);
    assert.equal((await badRes.json()).message, "Invalid rental type");

    // Price range bounds: minPrice, maxPrice, combined, negative/NaN/Infinity/min>max
    let priceRes = await fetch(`${baseUrl}/api/equipment?minPrice=10000`);
    assert.equal((await priceRes.json()).pagination.totalItems, 3);

    priceRes = await fetch(`${baseUrl}/api/equipment?maxPrice=4500`);
    assert.equal((await priceRes.json()).pagination.totalItems, 3);

    priceRes = await fetch(`${baseUrl}/api/equipment?minPrice=4000&maxPrice=15000`);
    assert.equal((await priceRes.json()).pagination.totalItems, 3);

    for (const invalidPriceQuery of [
      "minPrice=-5",
      "maxPrice=-1",
      "minPrice=abc",
      "minPrice=Infinity",
      "maxPrice=NaN",
      "minPrice=10000&maxPrice=2000",
    ]) {
      const res = await fetch(`${baseUrl}/api/equipment?${invalidPriceQuery}`);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).message, "Invalid price range");
    }

    // Availability: available vs unavailable (including legacy null availableQuantity)
    equipmentRows.push({
      ...equipmentRows[0],
      _id: new ObjectId("650000000000000000000010"),
      name: "Legacy Missing Qty Item",
      availableQuantity: null,
      createdAt: new Date("2026-09-01T00:00:00Z"),
    });

    let availRes = await fetch(`${baseUrl}/api/equipment?availability=available`);
    let availJson = await availRes.json();
    assert.equal(availRes.status, 200);
    assert.equal(availJson.pagination.totalItems, 5);
    assert.ok(availJson.data.every((i) => i.availableQuantity > 0));

    availRes = await fetch(`${baseUrl}/api/equipment?availability=unavailable`);
    availJson = await availRes.json();
    assert.equal(availRes.status, 200);
    assert.equal(availJson.pagination.totalItems, 3);
    assert.ok(availJson.data.every((i) => i.availableQuantity <= 0));

    badRes = await fetch(`${baseUrl}/api/equipment?availability=maybe`);
    assert.equal(badRes.status, 400);
    assert.equal((await badRes.json()).message, "Invalid availability filter");
  });

  test("SORTING, PAGINATION, COMBINED FILTERS & QUERY SPY VERIFICATION", async () => {
    // Price ascending with stable _id tiebreaker (3200 items ordered by _id asc)
    let res = await fetch(`${baseUrl}/api/equipment?sort=price_asc`);
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data[0]._id, "650000000000000000000005");
    assert.equal(json.data[1]._id, "650000000000000000000007");
    assert.equal(json.data[json.data.length - 1].rentalPrice, 65000);

    // Price descending
    res = await fetch(`${baseUrl}/api/equipment?sort=price_desc`);
    json = await res.json();
    assert.equal(json.data[0].rentalPrice, 65000);

    // Default sorting = newest first
    res = await fetch(`${baseUrl}/api/equipment`);
    json = await res.json();
    assert.equal(json.data[0].name, "Bosch [2026]* Special Drill");

    // Featured sort fallback
    res = await fetch(`${baseUrl}/api/equipment?sort=featured`);
    assert.equal(res.status, 200);

    // Invalid sort
    res = await fetch(`${baseUrl}/api/equipment?sort=random`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).message, "Invalid sorting option");

    // Pagination & limits
    res = await fetch(`${baseUrl}/api/equipment?page=2&limit=3`);
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 3);
    assert.deepEqual(json.pagination, {
      currentPage: 2,
      limit: 3,
      totalItems: 7,
      totalPages: 3,
    });

    // Out-of-range page still returns consistent metadata
    res = await fetch(`${baseUrl}/api/equipment?page=10&limit=3`);
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 0);
    assert.equal(json.message, "No matching equipment found");
    assert.equal(json.pagination.totalItems, 7);
    assert.equal(json.pagination.totalPages, 3);

    // Pagination error bounds: page=0, limit=51, limit=0
    for (const badPage of ["page=0", "page=-2", "limit=51", "limit=0", "page=abc"]) {
      const pRes = await fetch(`${baseUrl}/api/equipment?${badPage}`);
      assert.equal(pRes.status, 400);
      assert.equal((await pRes.json()).message, "Invalid pagination parameters");
    }

    // Combined filters (search + category + rentalType + minPrice + maxPrice + availability + sort + page + limit)
    spyOps.length = 0;
    res = await fetch(
      `${baseUrl}/api/equipment?search=excavator&category=${encodeURIComponent(
        "Construction Equipment"
      )}&rentalType=Daily&minPrice=3000&maxPrice=15000&availability=available&sort=price_asc&page=1&limit=9`
    );
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].name, "CAT Mini Excavator 302");

    // Confirm MongoDB query pipeline executed server-side filter, countDocuments, sort, skip & limit
    const findOp = spyOps.find((s) => s.op === "find");
    assert.equal(findOp.filter.status, EQUIPMENT_STATUSES.APPROVED);
    assert.equal(findOp.filter.category, "Construction Equipment");
    assert.equal(findOp.filter.rentalType, "Daily");
    assert.ok(spyOps.some((s) => s.op === "countDocuments"));
    assert.ok(spyOps.some((s) => s.op === "skip" && s.skip === 0));
    assert.ok(spyOps.some((s) => s.op === "limit" && s.limit === 9));

    // Also verify query builder preserves $and when BOTH search AND availability=unavailable are combined
    const combinedUnavailable = buildPublicEquipmentMongoQuery({
      search: "Tractor",
      availability: "unavailable",
      sort: "newest",
      page: 1,
      limit: 9,
    });
    assert.equal(combinedUnavailable.filter.$and.length, 2);
  });

  test("SECURITY: Approved-only enforcement, operator injection block & Owner /my preserved", async () => {
    // Public query CANNOT override status=Pending or status=Rejected
    for (const statusAttempt of ["Pending", "Rejected"]) {
      const res = await fetch(`${baseUrl}/api/equipment?status=${statusAttempt}`);
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.ok(json.data.every((i) => i.status === EQUIPMENT_STATUSES.APPROVED));
    }

    // MongoDB query operator object injection in query params rejected -> 400
    const opInjectRes = await fetch(
      `${baseUrl}/api/equipment?category[$ne]=Approved`
    );
    assert.equal(opInjectRes.status, 400);

    // Public response excludes private owner fields
    const pubRes = await fetch(`${baseUrl}/api/equipment`);
    const pubJson = await pubRes.json();
    assert.equal(pubJson.data[0].owner.name, "GearOwner");
    assert.equal(pubJson.data[0].owner.email, undefined);
    assert.equal(pubJson.data[0].owner.phone, undefined);
    assert.equal(pubJson.data[0].owner.passwordHash, undefined);

    // Owner GET /api/equipment/my continues returning Pending + Approved + Rejected listings
    const ownerToken = await mintOwnerJwt();
    const ownerRes = await fetch(`${baseUrl}/api/equipment/my`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const ownerJson = await ownerRes.json();
    assert.equal(ownerRes.status, 200);
    assert.equal(ownerJson.pagination.totalItems, 9);
    assert.ok(ownerJson.data.some((i) => i.status === EQUIPMENT_STATUSES.PENDING));
    assert.ok(ownerJson.data.some((i) => i.status === EQUIPMENT_STATUSES.REJECTED));

    // Featured returns <= 12 even if client passes ?limit=99
    const featRes = await fetch(`${baseUrl}/api/equipment/featured?limit=99`);
    assert.equal(featRes.status, 200);
    assert.ok((await featRes.json()).data.length <= 12);
  });
});
