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
import { BOOKING_INTENT_STATUSES, BOOKING_STATUSES } from "../src/constants/booking.js";
import { EQUIPMENT_STATUSES } from "../src/constants/equipment.js";
import { PAYMENT_STATUSES } from "../src/constants/payment.js";
import { USER_ROLES } from "../src/constants/roles.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { verifyRenter } from "../src/middleware/verifyRoles.js";
import { createVerifyTokenMiddleware } from "../src/middleware/verifyToken.js";
import { COLLECTIONS } from "../src/models/collections.js";
import { createBookingController, createBookingRouter } from "../src/routes/booking.routes.js";
import { createBookingService } from "../src/services/booking.service.js";
import { calculateRentalTotals } from "../src/utils/rentalCalculator.js";
import { validateRentalDateRange } from "../src/utils/rentalDate.js";

function matchesFilter(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or") {
      if (!v.some((clause) => matchesFilter(doc, clause))) return false;
      continue;
    }

    let val = doc;
    for (const part of k.split(".")) {
      val = val?.[part];
    }

    if (v && typeof v === "object" && !(v instanceof ObjectId) && !(v instanceof Date) && !Array.isArray(v)) {
      if ("$ne" in v && String(val) === String(v.$ne)) return false;
      if ("$nin" in v && v.$nin.some((c) => String(val) === String(c))) return false;
      if ("$lte" in v) {
        const dv = val instanceof Date ? val.getTime() : Number(val);
        const rv = v.$lte instanceof Date ? v.$lte.getTime() : Number(v.$lte);
        if (!(dv <= rv)) return false;
      }
      if ("$gte" in v) {
        const dv = val instanceof Date ? val.getTime() : Number(val);
        const rv = v.$gte instanceof Date ? v.$gte.getTime() : Number(v.$gte);
        if (!(dv >= rv)) return false;
      }
      if ("$gt" in v) {
        const dv = val instanceof Date ? val.getTime() : Number(val);
        const rv = v.$gt instanceof Date ? v.$gt.getTime() : Number(v.$gt);
        if (!(dv > rv)) return false;
      }
      if ("$regex" in v) {
        const rx = new RegExp(v.$regex, v.$options || "");
        if (!rx.test(String(val || ""))) return false;
      }
      continue;
    }

    if (val instanceof ObjectId || v instanceof ObjectId) {
      if (String(val) !== String(v)) return false;
    } else if (val instanceof Date || v instanceof Date) {
      if (new Date(val).getTime() !== new Date(v).getTime()) return false;
    } else if (val !== v) {
      return false;
    }
  }
  return true;
}

function projectStageDoc(doc, proj) {
  const out = {};
  for (const [k, expr] of Object.entries(proj)) {
    if (expr === 1) {
      if (k in doc) out[k] = doc[k];
    } else if (expr && typeof expr === "object") {
      const sub = {};
      for (const [sk, sv] of Object.entries(expr)) {
        const path = String(sv).replace(/^\$/, "");
        let v = doc;
        for (const p of path.split(".")) v = v?.[p];
        if (v !== undefined) sub[sk] = v;
      }
      out[k] = sub;
    }
  }
  return out;
}

function runAggregation(rowsRef, pipeline = [], extraStores = {}) {
  let docs = rowsRef.map((d) => ({ ...d }));

  for (const stage of pipeline) {
    if (stage.$match) {
      docs = docs.filter((d) => matchesFilter(d, stage.$match));
    } else if (stage.$group) {
      const sumField = String(stage.$group.reservedQuantity.$sum || "").replace(/^\$/, "");
      if (docs.length === 0) {
        docs = [];
      } else {
        const total = docs.reduce((acc, d) => acc + (Number(d[sumField]) || 0), 0);
        docs = [{ _id: null, reservedQuantity: total }];
      }
    } else if (stage.$lookup) {
      const { from, localField, foreignField, as } = stage.$lookup;
      const target = extraStores[from] || [];
      docs = docs.map((d) => ({
        ...d,
        [as]: target.filter((t) => String(t[foreignField]) === String(d[localField])),
      }));
    } else if (stage.$unwind) {
      const field = String(stage.$unwind.path || "").replace(/^\$/, "");
      const preserve = Boolean(stage.$unwind.preserveNullAndEmptyArrays);
      docs = docs.flatMap((d) => {
        const arr = d[field] || [];
        if (arr.length === 0) {
          return preserve ? [{ ...d, [field]: undefined }] : [];
        }
        return arr.map((item) => ({ ...d, [field]: item }));
      });
    } else if (stage.$project) {
      docs = docs.map((d) => projectStageDoc(d, stage.$project));
    } else if (stage.$sort) {
      const entries = Object.entries(stage.$sort);
      docs.sort((a, b) => {
        for (const [f, dir] of entries) {
          const av = a[f] instanceof Date ? a[f].getTime() : String(a[f] || "");
          const bv = b[f] instanceof Date ? b[f].getTime() : String(b[f] || "");
          if (av < bv) return dir === 1 ? -1 : 1;
          if (av > bv) return dir === 1 ? 1 : -1;
        }
        return 0;
      });
    } else if (typeof stage.$limit === "number") {
      docs = docs.slice(0, stage.$limit);
    } else if (stage.$facet) {
      const total = docs.length;
      let items = [...docs];
      for (const s of stage.$facet.items || []) {
        if (typeof s.$skip === "number") items = items.slice(s.$skip);
        if (typeof s.$limit === "number") items = items.slice(0, s.$limit);
      }
      docs = [{ metadata: total ? [{ total }] : [], items }];
    }
  }
  return docs;
}

describe("Booking & Rental Availability System (Commit 09)", () => {
  let issuer;
  let jwksServer;
  let apiServer;
  let baseUrl;
  let privateKey;

  let usersDb = [];
  let equipmentDb = [];
  let bookingsDb = [];
  let bookingIntentsDb = [];
  let paymentsDb = [];
  let spyStats = {
    txAttempts: 0,
    txRetries: 0,
    txCommits: 0,
    standaloneError: false,
  };

  let fixedNow = new Date("2026-11-22T12:00:00.000Z");

  const customerAId = new ObjectId().toString();
  const customerBId = "better-auth-customer-b-id";
  const ownerId = new ObjectId().toString();
  const adminId = new ObjectId().toString();

  const dailyEqId = new ObjectId();
  const weeklyEqId = new ObjectId();
  const monthlyEqId = new ObjectId();
  const pendingEqId = new ObjectId();
  const rejectedEqId = new ObjectId();

  async function signUserJwt(userId, role = USER_ROLES.CUSTOMER) {
    return new SignJWT({ role })
      .setProtectedHeader({ alg: "RS256", kid: "booking-key-1" })
      .setIssuer(issuer)
      .setAudience(issuer)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("20m")
      .sign(privateKey);
  }

  function createTransactionalCollaborators({ forceConcurrentConflict = false } = {}) {
    let activeParallelYield = forceConcurrentConflict;

    const resolveEquipmentView = (session) =>
      session?.txState?.equipment || equipmentDb;
    const resolveIntentsView = (session) =>
      session?.txState?.intents || bookingIntentsDb;

    return {
      setForceConcurrentConflict(flag) {
        activeParallelYield = Boolean(flag);
      },
      equipmentCollectionGetter: async () => ({
        async findOne(filter, options = {}) {
          const store = resolveEquipmentView(options.session);
          const found = store.find((d) => matchesFilter(d, filter));
          if (!found) return null;
          if (options.session?.txState && !(String(found._id) in options.session.txState.readVersions)) {
            options.session.txState.readVersions[String(found._id)] =
              found.reservationVersion || 0;
          }
          return { ...found };
        },
        async updateOne(filter, update, options = {}) {
          const session = options.session;
          if (!session?.txState) {
            const idx = equipmentDb.findIndex((d) => matchesFilter(d, filter));
            if (idx === -1) return { modifiedCount: 0 };
            if (update?.$inc?.reservationVersion) {
              equipmentDb[idx].reservationVersion =
                (equipmentDb[idx].reservationVersion || 0) + update.$inc.reservationVersion;
            }
            if (update?.$set) Object.assign(equipmentDb[idx], update.$set);
            return { modifiedCount: 1 };
          }

          if (activeParallelYield) {
            // Yield event loop turn so concurrent Promise.all callers overlap mid-transaction
            await new Promise((r) => setTimeout(r, 15));
          }

          const liveIdx = equipmentDb.findIndex((d) => matchesFilter(d, filter));
          if (liveIdx === -1) return { modifiedCount: 0 };

          const eqKey = String(equipmentDb[liveIdx]._id);
          const readVersion = session.txState.readVersions[eqKey] ?? 0;
          const currentLiveVersion = equipmentDb[liveIdx].reservationVersion || 0;
          if (currentLiveVersion !== readVersion) {
            const err = new Error("WriteConflict");
            err.code = 112;
            err.errorLabels = ["TransientTransactionError"];
            throw err;
          }

          const txIdx = session.txState.equipment.findIndex((d) =>
            matchesFilter(d, filter)
          );
          if (txIdx === -1) return { modifiedCount: 0 };
          if (update?.$inc?.reservationVersion) {
            session.txState.equipment[txIdx].reservationVersion =
              (session.txState.equipment[txIdx].reservationVersion || 0) +
              update.$inc.reservationVersion;
          }
          if (update?.$set) Object.assign(session.txState.equipment[txIdx], update.$set);
          session.txState.lockedEquipmentId = eqKey;
          session.txState.expectedVersion = readVersion;
          return { modifiedCount: 1 };
        },
      }),
      usersCollectionGetter: async () => ({
        async findOne(filter) {
          return usersDb.find((u) => matchesFilter(u, filter)) || null;
        },
      }),
      bookingsCollectionGetter: async () => ({
        aggregate(pipeline = []) {
          return {
            async toArray() {
              return runAggregation(bookingsDb, pipeline, {
                [COLLECTIONS.EQUIPMENT]: equipmentDb,
                [COLLECTIONS.PAYMENTS]: paymentsDb,
              });
            },
          };
        },
      }),
      bookingIntentsCollectionGetter: async () => ({
        async findOne(filter, options = {}) {
          const store = resolveIntentsView(options.session);
          return store.find((d) => matchesFilter(d, filter)) || null;
        },
        async updateMany(filter, update, options = {}) {
          const store = resolveIntentsView(options.session);
          let modifiedCount = 0;
          for (const d of store) {
            if (matchesFilter(d, filter)) {
              if (update?.$set) Object.assign(d, update.$set);
              modifiedCount += 1;
            }
          }
          return { modifiedCount };
        },
        async insertOne(doc, options = {}) {
          const store = resolveIntentsView(options.session);
          const _id = doc._id || new ObjectId();
          store.push({ ...doc, _id });
          return { insertedId: _id };
        },
        aggregate(pipeline = [], options = {}) {
          const store = resolveIntentsView(options.session);
          return {
            async toArray() {
              return runAggregation(store, pipeline, {
                [COLLECTIONS.EQUIPMENT]: equipmentDb,
              });
            },
          };
        },
      }),
      paymentsCollectionGetter: async () => ({}),
      mongoClientGetter: () => ({
        startSession() {
          const session = {
            txState: null,
            async withTransaction(fn) {
              if (spyStats.standaloneError) {
                const err = new Error(
                  "Transaction numbers are only allowed on a replica set member or mongos"
                );
                err.code = 20;
                err.codeName = "IllegalOperation";
                throw err;
              }

              for (let attempt = 0; attempt < 5; attempt += 1) {
                spyStats.txAttempts += 1;
                session.txState = {
                  equipment: equipmentDb.map((d) => ({ ...d })),
                  intents: bookingIntentsDb.map((d) => ({ ...d })),
                  readVersions: {},
                  lockedEquipmentId: null,
                  expectedVersion: 0,
                };
                try {
                  const res = await fn();
                  // Final commit write-conflict serialization check
                  if (session.txState.lockedEquipmentId) {
                    const liveEq = equipmentDb.find(
                      (e) => String(e._id) === session.txState.lockedEquipmentId
                    );
                    if (
                      (liveEq?.reservationVersion || 0) !==
                      session.txState.expectedVersion
                    ) {
                      const err = new Error("WriteConflict at commit");
                      err.code = 112;
                      err.errorLabels = ["TransientTransactionError"];
                      throw err;
                    }
                  }
                  equipmentDb.splice(0, equipmentDb.length, ...session.txState.equipment);
                  bookingIntentsDb.splice(
                    0,
                    bookingIntentsDb.length,
                    ...session.txState.intents
                  );
                  spyStats.txCommits += 1;
                  return res;
                } catch (err) {
                  session.txState = null;
                  if (err?.code === 112) {
                    spyStats.txRetries += 1;
                    continue;
                  }
                  throw err;
                }
              }
              throw new Error("Transaction retry limit exceeded");
            },
            async endSession() {
              session.txState = null;
            },
          };
          return session;
        },
      }),
      nowProvider: () => new Date(fixedNow.getTime()),
      holdMinutes: 10,
      transactionsEnabled: true,
    };
  }

  let collabCtrl;

  before(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    publicJwk.kid = "booking-key-1";
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

    collabCtrl = createTransactionalCollaborators();
    const service = createBookingService(collabCtrl);

    const app = express();
    app.use(express.json());
    app.use(
      "/api/bookings",
      createBookingRouter({
        authMiddleware: verifyToken,
        renterMiddleware: verifyRenter,
        controller: createBookingController(service),
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
    bookingIntentsDb.length = 0;
    paymentsDb.length = 0;
    spyStats = {
      txAttempts: 0,
      txRetries: 0,
      txCommits: 0,
      standaloneError: false,
    };
    fixedNow = new Date("2026-11-22T12:00:00.000Z");
    collabCtrl.setForceConcurrentConflict(false);

    usersDb.push(
      { _id: new ObjectId(customerAId), name: "Customer A", email: "a@test.com", role: USER_ROLES.CUSTOMER },
      { _id: customerBId, id: customerBId, name: "Customer B", email: "b@test.com", role: USER_ROLES.CUSTOMER },
      { _id: new ObjectId(ownerId), name: "Owner", email: "o@test.com", role: USER_ROLES.OWNER },
      { _id: new ObjectId(adminId), name: "Admin", email: "adm@test.com", role: USER_ROLES.ADMIN }
    );

    equipmentDb.push(
      {
        _id: dailyEqId,
        name: "Mini Excavator",
        category: "Construction Equipment",
        rentalType: "Daily",
        rentalPrice: 8500,
        availableQuantity: 5,
        image: "https://i.ibb.co/example/excavator.jpg",
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.APPROVED,
        reservationVersion: 0,
      },
      {
        _id: weeklyEqId,
        name: "100kVA Diesel Generator",
        category: "Construction Equipment",
        rentalType: "Weekly",
        rentalPrice: 15000,
        availableQuantity: 3,
        image: "https://i.ibb.co/example/gen.jpg",
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.APPROVED,
        reservationVersion: 0,
      },
      {
        _id: monthlyEqId,
        name: "Autonomous Combine Harvester",
        category: "Agriculture Equipment",
        rentalType: "Monthly",
        rentalPrice: 50000,
        availableQuantity: 2,
        image: "https://i.ibb.co/example/harvester.jpg",
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.APPROVED,
        reservationVersion: 0,
      },
      {
        _id: pendingEqId,
        name: "Pending Rig",
        category: "Electronics",
        rentalType: "Daily",
        rentalPrice: 2000,
        availableQuantity: 4,
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.PENDING,
        reservationVersion: 0,
      },
      {
        _id: rejectedEqId,
        name: "Rejected Rig",
        category: "Electronics",
        rentalType: "Daily",
        rentalPrice: 2000,
        availableQuantity: 4,
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.REJECTED,
        reservationVersion: 0,
      }
    );
  });

  test("AUTHORIZATION & DATE / QUANTITY / PRICING UTILITIES", async () => {
    const tokenCustomer = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);
    const tokenOwner = await signUserJwt(ownerId, USER_ROLES.OWNER);
    const tokenAdmin = await signUserJwt(adminId, USER_ROLES.ADMIN);

    // Unauthenticated rejected -> 401
    for (const [method, path] of [
      ["POST", "/api/bookings/check-availability"],
      ["POST", "/api/bookings"],
      ["GET", "/api/bookings/my"],
      ["GET", `/api/bookings/${new ObjectId().toString()}`],
    ]) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(res.status, 401);
    }

    // Owner and Admin rejected -> 403 Customer access required
    for (const badToken of [tokenOwner, tokenAdmin]) {
      for (const [method, path, body] of [
        ["POST", "/api/bookings/check-availability", { equipmentId: dailyEqId.toString(), startDate: "2026-11-24", endDate: "2026-11-26", quantity: 1 }],
        ["POST", "/api/bookings", { equipmentId: dailyEqId.toString(), startDate: "2026-11-24", endDate: "2026-11-26", quantity: 1, contactNumber: "01711111111", deliveryAddress: "Dhaka Yard 1" }],
        ["GET", "/api/bookings/my"],
      ]) {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${badToken}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).message, "Customer access required");
      }
    }

    // Inclusive date calculations + timezone boundary consistency
    const range3Days = validateRentalDateRange("2026-11-24", "2026-11-26", { now: fixedNow });
    assert.equal(range3Days.inclusiveDays, 3);
    assert.equal(range3Days.startDate.toISOString(), "2026-11-24T00:00:00.000Z");

    const sameDay = validateRentalDateRange("2026-11-22", "2026-11-22", {
      now: new Date("2026-11-22T23:55:00.000Z"),
    });
    assert.equal(sameDay.inclusiveDays, 1);

    // Reject past date, reversed dates, Feb 29 non-leap year, wrong format
    for (const [s, e] of [
      ["2026-11-21", "2026-11-25"],
      ["2026-11-26", "2026-11-24"],
      ["2026-02-29", "2026-03-01"],
      ["2026/11/24", "2026-11-26"],
      ["2026-11-24T00:00:00Z", "2026-11-26"],
    ]) {
      assert.throws(() => validateRentalDateRange(s, e, { now: fixedNow }), /Invalid rental date range/);
    }

    // Pricing formula checks (Daily, Weekly, Monthly, precision, invalid price)
    const dailyTotal = calculateRentalTotals({
      rentalPrice: 8500,
      rentalType: "Daily",
      inclusiveDays: 3,
      quantity: 2,
    });
    assert.equal(dailyTotal.billableUnits, 3);
    assert.equal(dailyTotal.totalAmount, 51000);
    assert.equal(dailyTotal.currency, "BDT");

    const weeklyTotal = calculateRentalTotals({
      rentalPrice: 15000,
      rentalType: "Weekly",
      inclusiveDays: 10,
      quantity: 2,
    });
    assert.equal(weeklyTotal.billableUnits, 2);
    assert.equal(weeklyTotal.totalAmount, 60000);

    const monthlyTotal = calculateRentalTotals({
      rentalPrice: 50000,
      rentalType: "Monthly",
      inclusiveDays: 45,
      quantity: 2,
    });
    assert.equal(monthlyTotal.billableUnits, 2);
    assert.equal(monthlyTotal.totalAmount, 200000);

    assert.throws(
      () =>
        calculateRentalTotals({
          rentalPrice: -10,
          rentalType: "Daily",
          inclusiveDays: 3,
          quantity: 1,
        }),
      /invalid/i
    );

    // Quantity validation checks on check-availability
    for (const badQty of [0, -1, 1.5, "abc", null, true]) {
      const res = await fetch(`${baseUrl}/api/bookings/check-availability`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenCustomer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          equipmentId: dailyEqId.toString(),
          startDate: "2026-11-24",
          endDate: "2026-11-26",
          quantity: badQty,
        }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).message, "Invalid rental quantity");
    }
  });

  test("AVAILABILITY ENGINE: Date overlap, exclusions, expired intents & approval checks", async () => {
    const token = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);

    // Seed mixed finalized bookings & temporary intents for Mini Excavator (total = 5)
    bookingsDb.push(
      // 1. Overlapping Active Paid booking: Nov 24-26, qty 2 -> COUNTS
      {
        _id: new ObjectId(),
        equipmentId: dailyEqId,
        customerId: customerBId,
        startDate: new Date("2026-11-24T00:00:00.000Z"),
        endDate: new Date("2026-11-26T00:00:00.000Z"),
        quantity: 2,
        bookingStatus: BOOKING_STATUSES.ACTIVE,
        paymentStatus: PAYMENT_STATUSES.PAID,
      },
      // 2. Adjacent earlier booking Nov 22-23 -> EXCLUDED for Nov 24-26
      {
        _id: new ObjectId(),
        equipmentId: dailyEqId,
        customerId: customerBId,
        startDate: new Date("2026-11-22T00:00:00.000Z"),
        endDate: new Date("2026-11-23T00:00:00.000Z"),
        quantity: 4,
        bookingStatus: BOOKING_STATUSES.COMPLETED,
        paymentStatus: PAYMENT_STATUSES.PAID,
      },
      // 3. Adjacent later booking Nov 27-29 -> EXCLUDED for Nov 24-26
      {
        _id: new ObjectId(),
        equipmentId: dailyEqId,
        customerId: customerBId,
        startDate: new Date("2026-11-27T00:00:00.000Z"),
        endDate: new Date("2026-11-29T00:00:00.000Z"),
        quantity: 4,
        bookingStatus: BOOKING_STATUSES.CONFIRMED,
        paymentStatus: PAYMENT_STATUSES.PAID,
      },
      // 4. Cancelled overlapping booking -> EXCLUDED
      {
        _id: new ObjectId(),
        equipmentId: dailyEqId,
        customerId: customerBId,
        startDate: new Date("2026-11-24T00:00:00.000Z"),
        endDate: new Date("2026-11-26T00:00:00.000Z"),
        quantity: 3,
        bookingStatus: BOOKING_STATUSES.CANCELLED,
        paymentStatus: PAYMENT_STATUSES.REFUNDED,
      }
    );

    bookingIntentsDb.push(
      // 5. Active unexpired hold overlapping Nov 25-27, qty 1 -> COUNTS
      {
        _id: new ObjectId(),
        equipmentId: dailyEqId,
        customerId: customerBId,
        startDate: new Date("2026-11-25T00:00:00.000Z"),
        endDate: new Date("2026-11-27T00:00:00.000Z"),
        quantity: 1,
        status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
        expiresAt: new Date(fixedNow.getTime() + 5 * 60 * 1000),
      },
      // 6. Expired PendingPayment hold (TTL not run yet) -> EXCLUDED by expiresAt > now
      {
        _id: new ObjectId(),
        equipmentId: dailyEqId,
        customerId: customerBId,
        startDate: new Date("2026-11-24T00:00:00.000Z"),
        endDate: new Date("2026-11-26T00:00:00.000Z"),
        quantity: 5,
        status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
        expiresAt: new Date(fixedNow.getTime() - 1000),
      }
    );

    // Requested qty 2 for Nov 24-26: reserved = 2 (booking) + 1 (unexpired hold) = 3, remaining = 2 -> available: true
    let res = await fetch(`${baseUrl}/api/bookings/check-availability`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        equipmentId: dailyEqId.toString(),
        startDate: "2026-11-24",
        endDate: "2026-11-26",
        quantity: 2,
      }),
    });
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(json.data, {
      available: true,
      equipmentId: dailyEqId.toString(),
      requestedQuantity: 2,
      totalQuantity: 5,
      reservedQuantity: 3,
      remainingQuantity: 2,
    });

    // Requested qty 3 -> remaining 2 -> available: false
    res = await fetch(`${baseUrl}/api/bookings/check-availability`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        equipmentId: dailyEqId.toString(),
        startDate: "2026-11-24",
        endDate: "2026-11-26",
        quantity: 3,
      }),
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.available, false);
    assert.equal(json.data.remainingQuantity, 2);

    // Pending / Rejected equipment rejected -> 409
    for (const eqId of [pendingEqId, rejectedEqId]) {
      const badRes = await fetch(`${baseUrl}/api/bookings/check-availability`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          equipmentId: eqId.toString(),
          startDate: "2026-11-24",
          endDate: "2026-11-26",
          quantity: 1,
        }),
      });
      assert.equal(badRes.status, 409);
    }

    // Nonexistent equipment -> 404
    const notFoundRes = await fetch(`${baseUrl}/api/bookings/check-availability`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        equipmentId: new ObjectId().toString(),
        startDate: "2026-11-24",
        endDate: "2026-11-26",
        quantity: 1,
      }),
    });
    assert.equal(notFoundRes.status, 404);
  });

  test("RESERVATION, EXPIRATION CLEANUP, ANTI-TAMPERING & CONCURRENCY RETRY", async () => {
    const tokenA = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);
    const tokenB = await signUserJwt(customerBId, USER_ROLES.CUSTOMER);

    // Seed an expired hold that must be cleaned up automatically during reservation
    const expiredHoldId = new ObjectId();
    bookingIntentsDb.push({
      _id: expiredHoldId,
      equipmentId: dailyEqId,
      customerId: customerBId,
      startDate: new Date("2026-11-24T00:00:00.000Z"),
      endDate: new Date("2026-11-26T00:00:00.000Z"),
      quantity: 4,
      status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
      expiresAt: new Date(fixedNow.getTime() - 60 * 1000),
    });

    // Reject frontend price/status/ownership manipulation
    for (const tamperedField of [
      { totalAmount: 1 },
      { rentalPrice: 1 },
      { billableUnits: 1 },
      { customerId: customerBId },
      { ownerId: customerAId },
      { paymentStatus: "Paid" },
      { bookingStatus: "Confirmed" },
    ]) {
      const tamperRes = await fetch(`${baseUrl}/api/bookings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          equipmentId: dailyEqId.toString(),
          startDate: "2026-11-24",
          endDate: "2026-11-26",
          quantity: 2,
          contactNumber: "01711111111",
          deliveryAddress: "Sector 7, Uttara, Dhaka",
          ...tamperedField,
        }),
      });
      assert.equal(tamperRes.status, 400);
    }

    // Valid reservation creation calculates exact server price & 10-minute expiration
    const payload = {
      equipmentId: dailyEqId.toString(),
      startDate: "2026-11-24",
      endDate: "2026-11-26",
      quantity: 2,
      contactNumber: "01711111111",
      deliveryAddress: "Sector 7, Uttara, Dhaka",
      additionalNotes: "Call upon arrival",
    };

    const createRes = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const createJson = await createRes.json();
    assert.equal(createRes.status, 201);
    assert.equal(createJson.data.status, BOOKING_INTENT_STATUSES.PENDING_PAYMENT);
    assert.equal(createJson.data.rentalPrice, 8500);
    assert.equal(createJson.data.billableUnits, 3);
    assert.equal(createJson.data.totalAmount, 51000);
    assert.equal(createJson.data.currency, "BDT");
    assert.equal(createJson.data.expiresAt, "2026-11-22T12:10:00.000Z");

    // Final bookings collection must remain untouched (payment not verified yet!)
    assert.equal(bookingsDb.length, 0);

    // Expired hold was marked Expired inside the transaction
    const expiredRec = bookingIntentsDb.find(
      (i) => String(i._id) === expiredHoldId.toString()
    );
    assert.equal(expiredRec.status, BOOKING_INTENT_STATUSES.EXPIRED);

    // Duplicate retry returns same unexpired reservation without double-reserving stock
    const dupRes = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(dupRes.status, 200);
    assert.equal(
      (await dupRes.json()).data.bookingIntentId,
      createJson.data.bookingIntentId
    );
    assert.equal(
      bookingIntentsDb.filter(
        (i) => i.status === BOOKING_INTENT_STATUSES.PENDING_PAYMENT
      ).length,
      1
    );

    // CONCURRENCY: Remaining quantity is 3; Customer A & Customer B simultaneously request qty 3!
    // One wins with 201, the other hits WriteConflict retry -> sees remaining 0 -> rejected 409!
    collabCtrl.setForceConcurrentConflict(true);
    const [raceA, raceB] = await Promise.all([
      fetch(`${baseUrl}/api/bookings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          equipmentId: dailyEqId.toString(),
          startDate: "2026-11-24",
          endDate: "2026-11-26",
          quantity: 3,
          contactNumber: "01711111111",
          deliveryAddress: "Dhaka Delivery Site A",
        }),
      }),
      fetch(`${baseUrl}/api/bookings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenB}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          equipmentId: dailyEqId.toString(),
          startDate: "2026-11-24",
          endDate: "2026-11-26",
          quantity: 3,
          contactNumber: "01822222222",
          deliveryAddress: "Dhaka Delivery Site B",
        }),
      }),
    ]);
    collabCtrl.setForceConcurrentConflict(false);

    const raceStatuses = [raceA.status, raceB.status].sort();
    assert.deepEqual(raceStatuses, [201, 409]);
    assert.ok(spyStats.txRetries >= 1);

    const activeHeldQty = bookingIntentsDb
      .filter((i) => i.status === BOOKING_INTENT_STATUSES.PENDING_PAYMENT)
      .reduce((sum, i) => sum + i.quantity, 0);
    assert.equal(activeHeldQty, 5); // Strictly <= inventory 5, zero over-reservation

    // Standalone MongoDB lacking replica set throws 503 TRANSACTIONS_REQUIRED without falling back
    spyStats.standaloneError = true;
    const standaloneRes = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        equipmentId: weeklyEqId.toString(),
        startDate: "2026-12-01",
        endDate: "2026-12-03",
        quantity: 1,
        contactNumber: "01711111111",
        deliveryAddress: "Dhaka Address",
      }),
    });
    spyStats.standaloneError = false;
    assert.equal(standaloneRes.status, 503);
    assert.equal(
      bookingIntentsDb.filter(
        (i) => String(i.equipmentId) === weeklyEqId.toString()
      ).length,
      0
    );

    // Disabled transactions config rejects safely (503) instead of unsafe insert
    const noTxService = createBookingService({
      ...collabCtrl,
      transactionsEnabled: false,
    });
    await assert.rejects(
      () =>
        noTxService.createBookingReservation({
          customerId: customerAId,
          payload: {
            equipmentId: weeklyEqId.toString(),
            startDate: "2026-12-01",
            endDate: "2026-12-03",
            quantity: 1,
            contactNumber: "01711111111",
            deliveryAddress: "Dhaka Address",
          },
        }),
      (err) => err.statusCode === 503
    );
  });

  test("CUSTOMER MY BOOKINGS, DETAILS, ISOLATION & BOOKING_INTENTS INDEXES", async () => {
    const tokenA = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);

    const bookingA1Id = new ObjectId();
    const bookingA2Id = new ObjectId();
    const bookingB1Id = new ObjectId();
    const tempIntentId = new ObjectId();

    bookingsDb.push(
      {
        _id: bookingA1Id,
        customerId: customerAId,
        ownerId,
        equipmentId: dailyEqId,
        startDate: new Date("2026-12-01T00:00:00.000Z"),
        endDate: new Date("2026-12-03T00:00:00.000Z"),
        quantity: 1,
        rentalType: "Daily",
        rentalPrice: 8500,
        totalAmount: 25500,
        currency: "BDT",
        paymentStatus: PAYMENT_STATUSES.PAID,
        bookingStatus: BOOKING_STATUSES.CONFIRMED,
        contactNumber: "01711111111",
        deliveryAddress: "Uttara Sector 4",
        additionalNotes: "Front gate",
        createdAt: new Date("2026-11-20T10:00:00.000Z"),
      },
      {
        _id: bookingA2Id,
        customerId: customerAId,
        ownerId,
        equipmentId: weeklyEqId,
        startDate: new Date("2026-12-05T00:00:00.000Z"),
        endDate: new Date("2026-12-11T00:00:00.000Z"),
        quantity: 1,
        rentalType: "Weekly",
        rentalPrice: 15000,
        totalAmount: 15000,
        currency: "BDT",
        paymentStatus: PAYMENT_STATUSES.PAID,
        bookingStatus: BOOKING_STATUSES.ACTIVE,
        contactNumber: "01711111111",
        deliveryAddress: "Gulshan 2",
        additionalNotes: "",
        createdAt: new Date("2026-11-21T10:00:00.000Z"), // newest
      },
      {
        _id: bookingB1Id,
        customerId: customerBId,
        ownerId,
        equipmentId: monthlyEqId,
        startDate: new Date("2026-12-10T00:00:00.000Z"),
        endDate: new Date("2026-12-20T00:00:00.000Z"),
        quantity: 1,
        rentalType: "Monthly",
        rentalPrice: 50000,
        totalAmount: 50000,
        currency: "BDT",
        paymentStatus: PAYMENT_STATUSES.PAID,
        bookingStatus: BOOKING_STATUSES.CONFIRMED,
        createdAt: new Date("2026-11-22T09:00:00.000Z"),
      }
    );

    paymentsDb.push({
      _id: new ObjectId(),
      bookingId: bookingA1Id,
      stripePaymentIntentId: "pi_test_123456",
      stripeSecretInternal: "NEVER_EXPOSE",
      paidAt: new Date("2026-11-20T10:05:00.000Z"),
      status: PAYMENT_STATUSES.PAID,
    });

    // Temporary intent must NEVER show in My Bookings or Booking Details
    bookingIntentsDb.push({
      _id: tempIntentId,
      customerId: customerAId,
      equipmentId: dailyEqId,
      status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
      expiresAt: new Date(fixedNow.getTime() + 600000),
    });

    // GET /api/bookings/my sorted newest first, paginated, isolated to Customer A
    let res = await fetch(`${baseUrl}/api/bookings/my?page=1&limit=1`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0]._id, bookingA2Id.toString());
    assert.equal(json.data[0].equipmentName, "100kVA Diesel Generator");
    assert.deepEqual(json.pagination, {
      currentPage: 1,
      limit: 1,
      totalItems: 2,
      totalPages: 2,
    });

    // GET /api/bookings/:id returns Customer A's details + safe payment info without secrets
    res = await fetch(`${baseUrl}/api/bookings/${bookingA1Id.toString()}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data._id, bookingA1Id.toString());
    assert.equal(json.data.durationDays, 3);
    assert.equal(json.data.transactionId, "pi_test_123456");
    assert.equal(json.data.deliveryAddress, "Uttara Sector 4");
    assert.equal(json.data.ownerId, undefined);
    assert.equal(json.data.stripeSecretInternal, undefined);

    // Cross-customer booking details -> 404
    res = await fetch(`${baseUrl}/api/bookings/${bookingB1Id.toString()}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 404);

    // Temporary intent ID on GET /api/bookings/:id -> 404
    res = await fetch(`${baseUrl}/api/bookings/${tempIntentId.toString()}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 404);

    // Malformed booking ID -> 400
    res = await fetch(`${baseUrl}/api/bookings/bad-id`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 400);

    // Verify bookingIntents TTL & overlap index definitions + idempotency
    const intentSpecs = COLLECTION_INDEX_SPECS[COLLECTIONS.BOOKING_INTENTS];
    assert.ok(
      intentSpecs.some(
        (s) =>
          s.key?.expiresAt === 1 &&
          s.options?.expireAfterSeconds === 0
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

    const run1 = await ensureDatabaseCollectionsAndIndexes(mockDb);
    const run2 = await ensureDatabaseCollectionsAndIndexes(mockDb);
    assert.ok(run1.indexesCreated > 0);
    assert.equal(run2.indexesCreated, 0);
  });
});
