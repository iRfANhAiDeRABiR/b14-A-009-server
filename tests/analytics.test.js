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
import { BOOKING_STATUSES } from "../src/constants/booking.js";
import { EQUIPMENT_STATUSES } from "../src/constants/equipment.js";
import { PAYMENT_STATUSES } from "../src/constants/payment.js";
import { USER_ROLES } from "../src/constants/roles.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { notFound } from "../src/middleware/notFound.js";
import { verifyAdmin, verifyOwner } from "../src/middleware/verifyRoles.js";
import { createVerifyTokenMiddleware } from "../src/middleware/verifyToken.js";
import { COLLECTIONS } from "../src/models/collections.js";
import {
  createAdminAnalyticsController,
  createAdminRouter,
} from "../src/routes/admin.routes.js";
import {
  createOwnerAnalyticsController,
  createOwnerRouter,
} from "../src/routes/owner.routes.js";
import { createAdminAnalyticsService } from "../src/services/adminAnalytics.service.js";
import { createOwnerAnalyticsService } from "../src/services/ownerAnalytics.service.js";

function getByPath(obj, path) {
  let curr = obj;
  for (const part of String(path).split(".")) {
    curr = curr?.[part];
  }
  return curr;
}

function compareValues(a, b) {
  const va =
    a instanceof Date
      ? a.getTime()
      : a instanceof ObjectId
        ? String(a)
        : a;
  const vb =
    b instanceof Date
      ? b.getTime()
      : b instanceof ObjectId
        ? String(b)
        : b;

  if (va === vb) return 0;
  if (va === undefined || va === null) return -1;
  if (vb === undefined || vb === null) return 1;
  if (typeof va === "number" && typeof vb === "number") return va - vb;
  return String(va) < String(vb) ? -1 : 1;
}

function matchesFilter(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or") {
      if (!v.some((clause) => matchesFilter(doc, clause))) return false;
      continue;
    }
    if (k === "$and") {
      if (!v.every((clause) => matchesFilter(doc, clause))) return false;
      continue;
    }

    const val = getByPath(doc, k);

    if (
      v &&
      typeof v === "object" &&
      !(v instanceof ObjectId) &&
      !(v instanceof Date) &&
      !Array.isArray(v)
    ) {
      if ("$ne" in v) {
        if (val === v.$ne || (val instanceof ObjectId && String(val) === String(v.$ne))) {
          return false;
        }
      }
      if ("$exists" in v) {
        const exists = val !== undefined;
        if (exists !== v.$exists) return false;
      }
      if ("$in" in v) {
        const ok = v.$in.some((c) =>
          val instanceof ObjectId || c instanceof ObjectId
            ? String(val) === String(c)
            : val === c
        );
        if (!ok) return false;
      }
      if ("$gte" in v) {
        if (compareValues(val, v.$gte) < 0) return false;
      }
      if ("$gt" in v) {
        if (compareValues(val, v.$gt) <= 0) return false;
      }
      if ("$lte" in v) {
        if (compareValues(val, v.$lte) > 0) return false;
      }
      if ("$lt" in v) {
        if (compareValues(val, v.$lt) >= 0) return false;
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

function evalExpression(doc, expr) {
  if (expr === null || expr === undefined) return expr;
  if (typeof expr === "string") {
    return expr.startsWith("$") ? getByPath(doc, expr.slice(1)) : expr;
  }
  if (typeof expr !== "object" || expr instanceof Date || expr instanceof ObjectId) {
    return expr;
  }
  if (Array.isArray(expr)) {
    return expr.map((item) => evalExpression(doc, item));
  }
  if ("$ifNull" in expr) {
    const [primary, fallback] = expr.$ifNull;
    const v = evalExpression(doc, primary);
    return v !== undefined && v !== null ? v : evalExpression(doc, fallback);
  }
  if ("$toString" in expr) {
    const v = evalExpression(doc, expr.$toString);
    return v === undefined || v === null ? null : String(v);
  }
  if ("$isNumber" in expr) {
    const v = evalExpression(doc, expr.$isNumber);
    return typeof v === "number" && Number.isFinite(v);
  }
  if ("$eq" in expr) {
    const [a, b] = expr.$eq.map((x) => evalExpression(doc, x));
    return a === b;
  }
  if ("$ne" in expr) {
    const [a, b] = expr.$ne.map((x) => evalExpression(doc, x));
    return a !== b;
  }
  if ("$gt" in expr) {
    const [a, b] = expr.$gt.map((x) => evalExpression(doc, x));
    return Number(a) > Number(b);
  }
  if ("$and" in expr) {
    return expr.$and.every((x) => Boolean(evalExpression(doc, x)));
  }
  if ("$cond" in expr) {
    const [cond, thenVal, elseVal] = expr.$cond;
    return evalExpression(doc, cond)
      ? evalExpression(doc, thenVal)
      : evalExpression(doc, elseVal);
  }
  if ("$subtract" in expr) {
    const [a, b] = expr.$subtract.map((x) => Number(evalExpression(doc, x) || 0));
    return a - b;
  }
  if ("$max" in expr) {
    const nums = expr.$max.map((x) => Number(evalExpression(doc, x) || 0));
    return Math.max(...nums);
  }
  if ("$dateToString" in expr) {
    const spec = expr.$dateToString;
    const rawDate = evalExpression(doc, spec.date);
    if (!rawDate) return null;
    const d = rawDate instanceof Date ? rawDate : new Date(rawDate);
    if (Number.isNaN(d.getTime())) return null;
    if (spec.format === "%Y-%m") {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    }
    return d.toISOString();
  }

  const out = {};
  for (const [k, v] of Object.entries(expr)) {
    out[k] = evalExpression(doc, v);
  }
  return out;
}

function runAggregatePipeline(inputDocs, pipeline) {
  let docs = inputDocs.map((d) => ({ ...d }));

  for (const stage of pipeline) {
    if ("$match" in stage) {
      docs = docs.filter((d) => matchesFilter(d, stage.$match));
      continue;
    }

    if ("$sort" in stage) {
      const sortEntries = Object.entries(stage.$sort);
      docs.sort((a, b) => {
        for (const [field, dir] of sortEntries) {
          const cmp = compareValues(getByPath(a, field), getByPath(b, field));
          if (cmp !== 0) return cmp * dir;
        }
        return 0;
      });
      continue;
    }

    if ("$project" in stage) {
      docs = docs.map((doc) => {
        const next = {};
        if (stage.$project._id !== 0 && "_id" in doc) {
          next._id = doc._id;
        }
        for (const [field, spec] of Object.entries(stage.$project)) {
          if (spec === 0) continue;
          if (spec === 1) {
            if (field in doc) next[field] = doc[field];
          } else {
            next[field] = evalExpression(doc, spec);
          }
        }
        return next;
      });
      continue;
    }

    if ("$group" in stage) {
      const { _id: idExpr, ...accumulators } = stage.$group;
      const groups = new Map();

      for (const doc of docs) {
        const groupId = evalExpression(doc, idExpr);
        const key =
          groupId && typeof groupId === "object"
            ? JSON.stringify(groupId)
            : String(groupId);
        if (!groups.has(key)) {
          const init = { _id: groupId };
          for (const accKey of Object.keys(accumulators)) {
            init[accKey] = undefined;
          }
          groups.set(key, { doc: init, firstSet: new Set() });
        }

        const entry = groups.get(key);
        for (const [accKey, accSpec] of Object.entries(accumulators)) {
          if ("$sum" in accSpec) {
            const addend = Number(evalExpression(doc, accSpec.$sum) || 0);
            entry.doc[accKey] = Number(entry.doc[accKey] || 0) + addend;
          } else if ("$first" in accSpec && !entry.firstSet.has(accKey)) {
            entry.doc[accKey] = evalExpression(doc, accSpec.$first);
            entry.firstSet.add(accKey);
          }
        }
      }

      docs = [...groups.values()].map((entry) => entry.doc);
      continue;
    }

    if ("$limit" in stage) {
      docs = docs.slice(0, stage.$limit);
      continue;
    }

    if ("$facet" in stage) {
      const facetOut = {};
      for (const [facetName, subPipeline] of Object.entries(stage.$facet)) {
        facetOut[facetName] = runAggregatePipeline(docs, subPipeline);
      }
      docs = [facetOut];
      continue;
    }
  }

  return docs;
}

function createAggregateCollectionStub(rowsRef, capturedPipelines = null) {
  return {
    async countDocuments(filter = {}) {
      return rowsRef.filter((d) => matchesFilter(d, filter)).length;
    },
    find(filter = {}, options = {}) {
      const matched = rowsRef.filter((d) => matchesFilter(d, filter));
      let sortSpec = null;
      let limitCount = null;
      return {
        sort(spec) {
          sortSpec = spec;
          return this;
        },
        limit(n) {
          limitCount = n;
          return this;
        },
        async toArray() {
          const copy = [...matched];
          if (sortSpec) {
            copy.sort((a, b) => {
              for (const [f, dir] of Object.entries(sortSpec)) {
                const cmp = compareValues(getByPath(a, f), getByPath(b, f));
                if (cmp !== 0) return cmp * dir;
              }
              return 0;
            });
          }
          const sliced = limitCount !== null ? copy.slice(0, limitCount) : copy;
          if (options?.projection) {
            return sliced.map((doc) => {
              const out = {};
              for (const [k, flag] of Object.entries(options.projection)) {
                if (flag === 1 && k in doc) out[k] = doc[k];
              }
              return out;
            });
          }
          return sliced;
        },
      };
    },
    async findOne(filter = {}) {
      return rowsRef.find((d) => matchesFilter(d, filter)) || null;
    },
    aggregate(pipeline) {
      if (capturedPipelines) {
        capturedPipelines.push(pipeline);
      }
      return {
        async toArray() {
          return runAggregatePipeline(rowsRef, pipeline);
        },
      };
    },
  };
}

describe("Commit 14: Admin & Owner Dashboard Analytics APIs", () => {
  let privateKey;
  let jwksServer;
  let jwksBaseUrl;
  let apiServer;
  let apiBaseUrl;

  let usersStore = [];
  let equipmentStore = [];
  let bookingsStore = [];
  let paymentsStore = [];
  let capturedAdminBookingPipelines = [];
  let capturedAdminPaymentPipelines = [];
  let capturedOwnerPaymentPipelines = [];

  const FIXED_NOW = new Date("2026-11-20T12:00:00.000Z");

  const ADMIN_ID = "user-admin-01";
  const OWNER_A_ID = "user-owner-a";
  const OWNER_B_ID = new ObjectId().toHexString();
  const CUSTOMER_ID = "user-customer-01";

  async function issueToken({ sub, email, role = USER_ROLES.CUSTOMER }) {
    return new SignJWT({ email, name: email.split("@")[0], role })
      .setProtectedHeader({ alg: "RS256", kid: "analytics-test-key" })
      .setSubject(sub)
      .setIssuer(jwksBaseUrl)
      .setAudience(jwksBaseUrl)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(privateKey);
  }

  async function requestJson(path, token = null) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${apiBaseUrl}${path}`, { headers });
    return { status: res.status, body: await res.json() };
  }

  before(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    publicJwk.kid = "analytics-test-key";
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
    jwksBaseUrl = `http://127.0.0.1:${jwksServer.address().port}`;
    clearRemoteJWKSetCache();

    const usersStub = createAggregateCollectionStub(usersStore);
    const equipmentStub = createAggregateCollectionStub(equipmentStore);

    const adminAnalyticsService = createAdminAnalyticsService({
      usersCollectionGetter: async () => createAggregateCollectionStub(usersStore),
      equipmentCollectionGetter: async () => createAggregateCollectionStub(equipmentStore),
      bookingsCollectionGetter: async () =>
        createAggregateCollectionStub(bookingsStore, capturedAdminBookingPipelines),
      paymentsCollectionGetter: async () =>
        createAggregateCollectionStub(paymentsStore, capturedAdminPaymentPipelines),
      nowProvider: () => FIXED_NOW,
    });

    const ownerAnalyticsService = createOwnerAnalyticsService({
      equipmentCollectionGetter: async () => createAggregateCollectionStub(equipmentStore),
      bookingsCollectionGetter: async () => createAggregateCollectionStub(bookingsStore),
      paymentsCollectionGetter: async () =>
        createAggregateCollectionStub(paymentsStore, capturedOwnerPaymentPipelines),
      usersCollectionGetter: async () => createAggregateCollectionStub(usersStore),
      nowProvider: () => FIXED_NOW,
    });

    const verifyTokenMiddleware = createVerifyTokenMiddleware({
      verifyAccessToken: (t) =>
        verifyJwtAccessToken(t, {
          jwksUrl: `${jwksBaseUrl}/api/auth/jwks`,
          issuer: jwksBaseUrl,
          audience: jwksBaseUrl,
        }),
      usersCollectionGetter: async () => usersStub,
    });

    const app = express();
    app.use(express.json());
    app.use(
      "/api/admin",
      createAdminRouter({
        authMiddleware: verifyTokenMiddleware,
        adminMiddleware: verifyAdmin,
        analyticsController: createAdminAnalyticsController(adminAnalyticsService),
      })
    );
    app.use(
      "/api/owner",
      createOwnerRouter({
        authMiddleware: verifyTokenMiddleware,
        ownerMiddleware: verifyOwner,
        analyticsController: createOwnerAnalyticsController(ownerAnalyticsService),
      })
    );
    app.use(notFound);
    app.use(errorHandler);

    await new Promise((resolve) => {
      apiServer = app.listen(0, "127.0.0.1", resolve);
    });
    apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}`;
  });

  after(async () => {
    clearRemoteJWKSetCache();
    await Promise.all([
      apiServer ? new Promise((r) => apiServer.close(r)) : Promise.resolve(),
      jwksServer ? new Promise((r) => jwksServer.close(r)) : Promise.resolve(),
    ]);
  });

  beforeEach(() => {
    usersStore.length = 0;
    equipmentStore.length = 0;
    bookingsStore.length = 0;
    paymentsStore.length = 0;
    capturedAdminBookingPipelines.length = 0;
    capturedAdminPaymentPipelines.length = 0;
    capturedOwnerPaymentPipelines.length = 0;

    usersStore.push(
      { _id: new ObjectId(), id: ADMIN_ID, name: "Platform Admin", email: "admin@gearnest.test", role: USER_ROLES.ADMIN, passwordHash: "$secret" },
      { _id: new ObjectId(), id: OWNER_A_ID, name: "Owner Alpha", email: "alpha@gearnest.test", role: USER_ROLES.OWNER, passwordHash: "$secret" },
      { _id: new ObjectId(OWNER_B_ID), id: OWNER_B_ID, name: "Owner Beta", email: "beta@gearnest.test", role: USER_ROLES.OWNER },
      { _id: new ObjectId(), id: CUSTOMER_ID, name: "Customer Zara", email: "zara@gearnest.test", role: USER_ROLES.CUSTOMER }
    );
  });

  function seedRichDataset() {
    const eqA1 = new ObjectId();
    const eqA2 = new ObjectId();
    const eqA3 = new ObjectId();
    const eqA4 = new ObjectId();
    const eqA5 = new ObjectId();
    const eqA6 = new ObjectId();
    const eqAArchived = new ObjectId();
    const eqB1 = new ObjectId();

    equipmentStore.push(
      { _id: eqA1, ownerId: OWNER_A_ID, name: "CAT Excavator 320", category: "Construction Equipment", rentalPrice: 15000, rentalType: "Daily", status: EQUIPMENT_STATUSES.APPROVED, availableQuantity: 2, isDeleted: false, createdAt: new Date("2026-01-10T08:00:00.000Z") },
      { _id: eqA2, ownerId: OWNER_A_ID, name: "Sony FX6 Cinema Rig", category: "Photography Equipment", rentalPrice: 6500, rentalType: "Daily", status: EQUIPMENT_STATUSES.APPROVED, availableQuantity: 1, isDeleted: false, createdAt: new Date("2026-02-10T08:00:00.000Z") },
      { _id: eqA3, ownerId: OWNER_A_ID, name: "Honda Generator 10kW", category: "Electronics", rentalPrice: 4000, rentalType: "Daily", status: EQUIPMENT_STATUSES.PENDING, availableQuantity: 3, isDeleted: false, createdAt: new Date("2026-03-10T08:00:00.000Z") },
      { _id: eqA4, ownerId: OWNER_A_ID, name: "Kubota Tractor", category: "Agriculture Equipment", rentalPrice: 8000, rentalType: "Daily", status: EQUIPMENT_STATUSES.REJECTED, availableQuantity: 1, isDeleted: false, createdAt: new Date("2026-04-10T08:00:00.000Z") },
      { _id: eqA5, ownerId: OWNER_A_ID, name: "JBL PA Sound Array", category: "Event Equipment", rentalPrice: 5000, rentalType: "Daily", status: EQUIPMENT_STATUSES.APPROVED, availableQuantity: 0, isDeleted: false, createdAt: new Date("2026-05-10T08:00:00.000Z") },
      { _id: eqA6, ownerId: OWNER_A_ID, name: "Scissor Lift 12m", category: "Construction Equipment", rentalPrice: 7000, rentalType: "Daily", status: EQUIPMENT_STATUSES.APPROVED, availableQuantity: 2, isDeleted: false, createdAt: new Date("2026-06-10T08:00:00.000Z") },
      { _id: eqAArchived, ownerId: OWNER_A_ID, name: "Archived Crane", category: "Construction Equipment", rentalPrice: 20000, rentalType: "Daily", status: EQUIPMENT_STATUSES.APPROVED, availableQuantity: 1, isDeleted: true, createdAt: new Date("2025-11-10T08:00:00.000Z") },
      { _id: eqB1, ownerId: new ObjectId(OWNER_B_ID), name: "Beta Drone RTK", category: "Photography Equipment", rentalPrice: 9000, rentalType: "Daily", status: EQUIPMENT_STATUSES.PENDING, availableQuantity: 1, isDeleted: false, createdAt: new Date("2026-10-15T08:00:00.000Z") }
    );

    const bOld = new ObjectId(); // Jan 2026 (outside 3m & 6m, inside 12m)
    const bOctBoundary = new ObjectId(); // 2026-10-31T23:59:59.999Z -> Oct 2026
    const bNovBoundary = new ObjectId(); // 2026-11-01T00:00:00.000Z -> Nov 2026
    const bNovPending = new ObjectId(); // Unpaid booking
    const bNovRefunded = new ObjectId(); // Refunded booking
    const bOwnerB = new ObjectId(); // Belongs to Owner B
    const bArchivedEq = new ObjectId(); // Historical booking on Owner A archived item

    bookingsStore.push(
      { _id: bOld, equipmentId: eqA1, ownerId: OWNER_A_ID, customerId: CUSTOMER_ID, startDate: "2026-01-12", endDate: "2026-01-13", durationDays: 2, quantity: 1, totalAmount: 30000, bookingStatus: BOOKING_STATUSES.COMPLETED, paymentStatus: PAYMENT_STATUSES.PAID, createdAt: new Date("2026-01-11T10:00:00.000Z") },
      { _id: bOctBoundary, equipmentId: eqA2, ownerId: OWNER_A_ID, customerId: CUSTOMER_ID, startDate: "2026-11-02", endDate: "2026-11-03", durationDays: 2, quantity: 1, totalAmount: 13000, bookingStatus: BOOKING_STATUSES.COMPLETED, paymentStatus: PAYMENT_STATUSES.PAID, createdAt: new Date("2026-10-31T23:59:59.999Z") },
      { _id: bNovBoundary, equipmentId: eqA1, ownerId: OWNER_A_ID, customerId: CUSTOMER_ID, startDate: "2026-11-05", endDate: "2026-11-05", durationDays: 1, quantity: 1, totalAmount: 15000, bookingStatus: BOOKING_STATUSES.CONFIRMED, paymentStatus: PAYMENT_STATUSES.PAID, createdAt: new Date("2026-11-01T00:00:00.000Z") },
      { _id: bNovPending, equipmentId: eqA5, ownerId: OWNER_A_ID, customerId: CUSTOMER_ID, startDate: "2026-11-10", endDate: "2026-11-10", durationDays: 1, quantity: 1, totalAmount: 5000, bookingStatus: BOOKING_STATUSES.PENDING, paymentStatus: PAYMENT_STATUSES.PENDING, createdAt: new Date("2026-11-10T09:00:00.000Z") },
      { _id: bNovRefunded, equipmentId: eqA6, ownerId: OWNER_A_ID, customerId: CUSTOMER_ID, startDate: "2026-11-12", endDate: "2026-11-12", durationDays: 1, quantity: 1, totalAmount: 7000, bookingStatus: BOOKING_STATUSES.CANCELLED, paymentStatus: PAYMENT_STATUSES.REFUNDED, createdAt: new Date("2026-11-12T09:00:00.000Z") },
      { _id: bArchivedEq, equipmentId: eqAArchived, ownerId: OWNER_A_ID, customerId: CUSTOMER_ID, startDate: "2026-09-02", endDate: "2026-09-02", durationDays: 1, quantity: 1, totalAmount: 20000, bookingStatus: BOOKING_STATUSES.COMPLETED, paymentStatus: PAYMENT_STATUSES.PAID, createdAt: new Date("2026-09-01T12:00:00.000Z") },
      { _id: bOwnerB, equipmentId: eqB1, ownerId: new ObjectId(OWNER_B_ID), customerId: CUSTOMER_ID, startDate: "2026-11-15", endDate: "2026-11-15", durationDays: 1, quantity: 1, totalAmount: 9000, bookingStatus: BOOKING_STATUSES.COMPLETED, paymentStatus: PAYMENT_STATUSES.PAID, createdAt: new Date("2026-11-15T12:00:00.000Z") }
    );

    paymentsStore.push(
      // Jan 2026 Paid (amountMinor intentionally 100x to verify amount vs amountMinor never mixes)
      { _id: new ObjectId(), bookingId: bOld, equipmentId: eqA1, ownerId: OWNER_A_ID, amount: 30000, amountMinor: 3000000, currency: "bdt", status: PAYMENT_STATUSES.PAID, stripeCheckoutSessionId: "cs_old", stripePaymentIntentId: "pi_old", paidAt: new Date("2026-01-11T10:05:00.000Z"), createdAt: new Date("2026-01-11T10:05:00.000Z") },
      // Duplicate Paid attempt on same bookingId -> MUST NOT double count!
      { _id: new ObjectId(), bookingId: bOld, equipmentId: eqA1, ownerId: OWNER_A_ID, amount: 30000, amountMinor: 3000000, currency: "bdt", status: PAYMENT_STATUSES.PAID, stripeCheckoutSessionId: "cs_old_dup", stripePaymentIntentId: "pi_old_dup", paidAt: new Date("2026-01-11T10:06:00.000Z"), createdAt: new Date("2026-01-11T10:06:00.000Z") },
      // Oct boundary with partial refund (13000 - 1000 refundedAmount = 12000 net)
      { _id: new ObjectId(), bookingId: bOctBoundary, equipmentId: eqA2, ownerId: OWNER_A_ID, amount: 13000, refundedAmount: 1000, amountMinor: 1300000, currency: "bdt", status: PAYMENT_STATUSES.PAID, stripeCheckoutSessionId: "cs_oct", stripePaymentIntentId: "pi_oct", paidAt: new Date("2026-10-31T23:59:59.999Z"), createdAt: new Date("2026-10-31T23:59:59.999Z") },
      // Nov boundary Paid (missing ownerId & equipmentId on legacy payment row to test booking link fallback!)
      { _id: new ObjectId(), bookingId: bNovBoundary, amount: 15000, amountMinor: 1500000, currency: "bdt", status: PAYMENT_STATUSES.PAID, stripeCheckoutSessionId: "cs_nov", stripePaymentIntentId: "pi_nov", paidAt: new Date("2026-11-01T00:00:00.000Z"), createdAt: new Date("2026-11-01T00:00:00.000Z") },
      // Pending, Failed, Refunded -> MUST be excluded!
      { _id: new ObjectId(), bookingId: bNovPending, equipmentId: eqA5, ownerId: OWNER_A_ID, amount: 5000, status: PAYMENT_STATUSES.PENDING, stripeCheckoutSessionId: "cs_pend", createdAt: new Date("2026-11-10T09:05:00.000Z") },
      { _id: new ObjectId(), bookingId: bNovPending, equipmentId: eqA5, ownerId: OWNER_A_ID, amount: 5000, status: PAYMENT_STATUSES.FAILED, stripeCheckoutSessionId: "cs_fail", createdAt: new Date("2026-11-10T09:06:00.000Z") },
      { _id: new ObjectId(), bookingId: bNovRefunded, equipmentId: eqA6, ownerId: OWNER_A_ID, amount: 7000, status: PAYMENT_STATUSES.REFUNDED, stripeCheckoutSessionId: "cs_ref", stripePaymentIntentId: "pi_ref", paidAt: new Date("2026-11-12T09:05:00.000Z"), createdAt: new Date("2026-11-12T09:05:00.000Z") },
      // Sep archived equipment paid rental (20000)
      { _id: new ObjectId(), bookingId: bArchivedEq, equipmentId: eqAArchived, ownerId: OWNER_A_ID, amount: 20000, status: PAYMENT_STATUSES.PAID, stripeCheckoutSessionId: "cs_arch", stripePaymentIntentId: "pi_arch", paidAt: new Date("2026-09-01T12:05:00.000Z"), createdAt: new Date("2026-09-01T12:05:00.000Z") },
      // Owner B Paid (9000) stored with ObjectId ownerId
      { _id: new ObjectId(), bookingId: bOwnerB, equipmentId: eqB1, ownerId: new ObjectId(OWNER_B_ID), amount: 9000, status: PAYMENT_STATUSES.PAID, stripeCheckoutSessionId: "cs_b", stripePaymentIntentId: "pi_b", paidAt: new Date("2026-11-15T12:05:00.000Z"), createdAt: new Date("2026-11-15T12:05:00.000Z") }
    );
  }

  test("Admin & Owner endpoints enforce JWT authentication and strict role authorization", async () => {
    const adminToken = await issueToken({ sub: ADMIN_ID, email: "admin@gearnest.test", role: USER_ROLES.ADMIN });
    const ownerToken = await issueToken({ sub: OWNER_A_ID, email: "alpha@gearnest.test", role: USER_ROLES.OWNER });
    const customerToken = await issueToken({ sub: CUSTOMER_ID, email: "zara@gearnest.test", role: USER_ROLES.CUSTOMER });

    // Unauthenticated rejected
    assert.equal((await requestJson("/api/admin/analytics")).status, 401);
    assert.equal((await requestJson("/api/owner/analytics")).status, 401);

    // Non-admin rejected from admin analytics
    assert.equal((await requestJson("/api/admin/analytics", customerToken)).status, 403);
    assert.equal((await requestJson("/api/admin/analytics", ownerToken)).status, 403);

    // Non-owner rejected from owner analytics
    assert.equal((await requestJson("/api/owner/analytics", customerToken)).status, 403);
    assert.equal((await requestJson("/api/owner/analytics", adminToken)).status, 403);

    // Stale JWT check: demoted Owner gets 403 immediately from DB lookup
    const alphaUser = usersStore.find((u) => u.id === OWNER_A_ID);
    alphaUser.role = USER_ROLES.CUSTOMER;
    assert.equal((await requestJson("/api/owner/analytics", ownerToken)).status, 403);
  });

  test("Rejects unsupported period parameters and query operator injection with HTTP 400", async () => {
    const adminToken = await issueToken({ sub: ADMIN_ID, email: "admin@gearnest.test", role: USER_ROLES.ADMIN });
    const ownerToken = await issueToken({ sub: OWNER_A_ID, email: "alpha@gearnest.test", role: USER_ROLES.OWNER });

    for (const invalidQuery of ["?period=24m", "?period=all", "?period=invalid", "?period=3m&period=6m", "?period[$ne]=12m"]) {
      const adminRes = await requestJson(`/api/admin/analytics${invalidQuery}`, adminToken);
      assert.equal(adminRes.status, 400);
      assert.equal(adminRes.body.message, "Invalid reporting period");

      const ownerRes = await requestJson(`/api/owner/analytics${invalidQuery}`, ownerToken);
      assert.equal(ownerRes.status, 400);
      assert.equal(ownerRes.body.message, "Invalid reporting period");
    }
  });

  test("Admin analytics computes real MongoDB aggregation KPIs, deduplicated revenue, UTC month series, and safe activity", async () => {
    seedRichDataset();
    const adminToken = await issueToken({ sub: ADMIN_ID, email: "admin@gearnest.test", role: USER_ROLES.ADMIN });

    // Default -> 12m
    const res12m = await requestJson("/api/admin/analytics", adminToken);
    assert.equal(res12m.status, 200);
    const d12 = res12m.body.data;

    assert.equal(d12.period, "12m");
    assert.equal(d12.totalUsers, 4);
    assert.equal(d12.totalEquipment, 7); // 8th item is soft-deleted (isDeleted: true)
    assert.equal(d12.totalBookings, 7);
    assert.equal(d12.pendingApprovals, 2); // eqA3 + eqB1
    assert.equal(d12.completedRentals, 4); // bOld, bOctBoundary, bArchivedEq, bOwnerB
    // Paid net revenue = 30000 (dedup bOld) + 12000 (bOct net) + 15000 (bNov) + 20000 (bArchivedEq) + 9000 (bOwnerB) = 86000
    assert.equal(d12.totalRevenue, 86000);
    // Nov 2026 bookings = bNovBoundary + bNovPending + bNovRefunded + bOwnerB = 4
    assert.equal(d12.monthlyBookings, 4);
    assert.equal(d12.monthlyBookingData.length, 12);
    assert.equal(d12.monthlyRevenueData.length, 12);

    // UTC boundary verification: Oct vs Nov 2026
    const octBooking = d12.monthlyBookingData.find((m) => m.yearMonth === "2026-10");
    const novBooking = d12.monthlyBookingData.find((m) => m.yearMonth === "2026-11");
    assert.equal(octBooking.bookings, 1);
    assert.equal(novBooking.bookings, 4);

    const octRev = d12.monthlyRevenueData.find((m) => m.yearMonth === "2026-10");
    const novRev = d12.monthlyRevenueData.find((m) => m.yearMonth === "2026-11");
    assert.equal(octRev.revenue, 12000);
    assert.equal(novRev.revenue, 24000); // 15000 + 9000

    assert.deepEqual(d12.equipmentApprovalData, [
      { status: "Pending", count: 2 },
      { status: "Approved", count: 4 },
      { status: "Rejected", count: 1 },
    ]);

    // Verify 3m keeps all-time KPIs identical while windowing monthly arrays to 3 zero-filled UTC months
    const res3m = await requestJson("/api/admin/analytics?period=3m", adminToken);
    assert.equal(res3m.status, 200);
    const d3 = res3m.body.data;
    assert.equal(d3.period, "3m");
    assert.equal(d3.totalRevenue, 86000);
    assert.equal(d3.totalBookings, 7);
    assert.deepEqual(
      d3.monthlyRevenueData.map((m) => [m.yearMonth, m.revenue]),
      [
        ["2026-09", 20000],
        ["2026-10", 12000],
        ["2026-11", 24000],
      ]
    );

    // Verify zero secrets leaked and real aggregation stages emitted
    const serialized = JSON.stringify(res12m.body);
    assert.equal(serialized.includes("$secret"), false);
    assert.equal(serialized.includes("passwordHash"), false);
    assert.ok(capturedAdminBookingPipelines.some((p) => "$facet" in p[0]));
    assert.ok(
      JSON.stringify(capturedAdminBookingPipelines[0]).includes('"timezone":"UTC"')
    );
    assert.ok(capturedAdminPaymentPipelines.some((p) => p.some((s) => "$group" in s)));
  });

  test("Owner analytics isolates data strictly by verified JWT ownerId across ID types, computes top 5 equipmentPerformance, and handles zero data", async () => {
    const ownerAToken = await issueToken({ sub: OWNER_A_ID, email: "alpha@gearnest.test", role: USER_ROLES.OWNER });
    const ownerBToken = await issueToken({ sub: OWNER_B_ID, email: "beta@gearnest.test", role: USER_ROLES.OWNER });

    // Empty database baseline for Owner A
    const emptyRes = await requestJson("/api/owner/analytics?period=6m", ownerAToken);
    assert.equal(emptyRes.status, 200);
    assert.equal(emptyRes.body.data.totalListedEquipment, 0);
    assert.equal(emptyRes.body.data.completedRentals, 0);
    assert.equal(emptyRes.body.data.totalEarnings, 0);
    assert.equal(emptyRes.body.data.monthlyEarnings, 0);
    assert.equal(emptyRes.body.data.monthlyEarningsData.length, 6);
    assert.equal(emptyRes.body.data.monthlyRentalData.length, 6);
    assert.deepEqual(emptyRes.body.data.equipmentPerformance, []);
    assert.deepEqual(emptyRes.body.data.recentRentals, []);

    seedRichDataset();

    // Passing forged ownerId query param must be ignored completely (always uses JWT owner)
    const ownerARes = await requestJson(
      `/api/owner/analytics?period=6m&ownerId=${OWNER_B_ID}`,
      ownerAToken
    );
    assert.equal(ownerARes.status, 200);
    const a = ownerARes.body.data;

    assert.equal(a.period, "6m");
    assert.equal(a.totalListedEquipment, 6); // 6 non-deleted listings; eqAArchived excluded from active fleet
    assert.deepEqual(a.equipmentStatusBreakdown, {
      approved: 4,
      pending: 1,
      rejected: 1,
    });
    assert.equal(a.completedRentals, 3); // bOld, bOctBoundary, bArchivedEq (excludes bOwnerB)
    // Owner A total net paid earnings = 30000 + 12000 + 15000 + 20000 = 77000 (excludes Owner B 9000 & unpaid/failed/refunded)
    assert.equal(a.totalEarnings, 77000);
    // Current UTC calendar month (Nov 2026) earnings for Owner A = 15000 (legacy bNovBoundary resolved via booking link!)
    assert.equal(a.monthlyEarnings, 15000);
    assert.equal(a.monthlyEarningsData.length, 6);
    assert.equal(a.monthlyRentalData.length, 6);

    // Equipment performance: limited to top 5, ordered by earningsGenerated desc
    assert.equal(a.equipmentPerformance.length, 5);
    assert.equal(a.equipmentPerformance[0].name, "CAT Excavator 320");
    assert.equal(a.equipmentPerformance[0].rentalsCount, 2);
    assert.equal(a.equipmentPerformance[0].earningsGenerated, 45000); // 30000 + 15000
    assert.equal(a.equipmentPerformance[1].name, "Sony FX6 Cinema Rig");
    assert.equal(a.equipmentPerformance[1].earningsGenerated, 12000);

    // Recent rentals: capped at 5 and never exposes password hashes or other owner's bookings
    assert.equal(a.recentRentals.length, 5);
    assert.equal(a.recentRentals.some((r) => r.equipment.name === "Beta Drone RTK"), false);

    // Owner B (ObjectId-stored ID) sees strictly Owner B's metrics (9000)
    const ownerBRes = await requestJson("/api/owner/analytics?period=3m", ownerBToken);
    assert.equal(ownerBRes.status, 200);
    assert.equal(ownerBRes.body.data.totalListedEquipment, 1);
    assert.equal(ownerBRes.body.data.completedRentals, 1);
    assert.equal(ownerBRes.body.data.totalEarnings, 9000);
    assert.equal(ownerBRes.body.data.monthlyEarnings, 9000);
    assert.equal(ownerBRes.body.data.monthlyEarningsData.length, 3);

    const serializedOwnerA = JSON.stringify(ownerARes.body);
    assert.equal(serializedOwnerA.includes("$secret"), false);
    assert.equal(serializedOwnerA.includes("passwordHash"), false);
  });

  test("Database analytics payment indexes are registered and idempotent", async () => {
    const paymentIndexNames = COLLECTION_INDEX_SPECS[COLLECTIONS.PAYMENTS].map(
      (i) => i.options.name
    );
    assert.ok(paymentIndexNames.includes("payments_status_paid_at_idx"));
    assert.ok(paymentIndexNames.includes("payments_owner_status_paid_at_idx"));
    assert.ok(paymentIndexNames.includes("payments_status_created_at_idx"));

    const existingIndexes = {
      [COLLECTIONS.PAYMENTS]: [],
    };
    let createdCount = 0;

    const fakeDb = {
      listCollections: () => ({
        toArray: async () =>
          Object.values(COLLECTIONS).map((name) => ({ name })),
      }),
      createCollection: async () => {},
      collection: (name) => ({
        listIndexes: () => ({
          toArray: async () => existingIndexes[name] || [],
        }),
        createIndex: async (key, options) => {
          createdCount += 1;
          existingIndexes[name] = existingIndexes[name] || [];
          const isText = Object.values(key).some((v) => v === "text");
          existingIndexes[name].push(
            isText
              ? { key: { _fts: "text", _ftsx: 1 }, weights: key, ...options }
              : { key, ...options }
          );
          return options.name;
        },
      }),
    };

    const first = await ensureDatabaseCollectionsAndIndexes(fakeDb);
    const second = await ensureDatabaseCollectionsAndIndexes(fakeDb);
    assert.ok(first.indexesCreated > 0);
    assert.equal(second.indexesCreated, 0);
    assert.ok(
      existingIndexes[COLLECTIONS.PAYMENTS].some(
        (idx) => idx.name === "payments_status_paid_at_idx"
      )
    );
  });
});
