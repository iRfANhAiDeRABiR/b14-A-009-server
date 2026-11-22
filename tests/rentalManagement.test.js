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
import { createAdminRentalController, createAdminRouter } from "../src/routes/admin.routes.js";
import { createBookingController, createBookingRouter } from "../src/routes/booking.routes.js";
import { createOwnerRentalController, createOwnerRouter } from "../src/routes/owner.routes.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { notFound } from "../src/middleware/notFound.js";
import { verifyAdmin, verifyOwner, verifyRenter } from "../src/middleware/verifyRoles.js";
import { createVerifyTokenMiddleware } from "../src/middleware/verifyToken.js";
import { COLLECTIONS } from "../src/models/collections.js";
import { createAdminRentalService } from "../src/services/adminRental.service.js";
import { createBookingService } from "../src/services/booking.service.js";
import { createOwnerRentalService } from "../src/services/ownerRental.service.js";

function getByPath(obj, path) {
  let curr = obj;
  for (const part of String(path).split(".")) {
    curr = curr?.[part];
  }
  return curr;
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

    if (v && typeof v === "object" && !(v instanceof ObjectId) && !(v instanceof Date) && !Array.isArray(v)) {
      if ("$in" in v) {
        const ok = v.$in.some((c) =>
          val instanceof ObjectId || c instanceof ObjectId
            ? String(val) === String(c)
            : val === c
        );
        if (!ok) return false;
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
        const val = getByPath(doc, String(sv).replace(/^\$/, ""));
        if (val !== undefined) sub[sk] = val;
      }
      out[k] = sub;
    }
  }
  return out;
}

function evalCondExpr(doc, expr) {
  if (expr?.$eq) {
    const [left, right] = expr.$eq;
    const lv = String(left).startsWith("$") ? getByPath(doc, String(left).slice(1)) : left;
    return lv === right;
  }
  if (expr?.$in) {
    const [left, arr] = expr.$in;
    const lv = String(left).startsWith("$") ? getByPath(doc, String(left).slice(1)) : left;
    return arr.includes(lv);
  }
  return false;
}

function runPipeline(rowsRef, pipeline = [], extraStores = {}) {
  let docs = rowsRef.map((d) => ({ ...d }));

  for (const stage of pipeline) {
    if (stage.$match) {
      docs = docs.filter((d) => matchesFilter(d, stage.$match));
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
    } else if (typeof stage.$limit === "number") {
      docs = docs.slice(0, stage.$limit);
    } else if (stage.$group) {
      if (docs.length === 0) {
        docs = [];
      } else {
        const acc = { _id: null };
        for (const [key, op] of Object.entries(stage.$group)) {
          if (key === "_id") continue;
          if (op.$sum === 1) {
            acc[key] = docs.length;
          } else if (op.$sum?.$cond) {
            const [cond, tVal, fVal] = op.$sum.$cond;
            acc[key] = docs.reduce(
              (sum, d) => sum + (evalCondExpr(d, cond) ? tVal : fVal),
              0
            );
          }
        }
        docs = [acc];
      }
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

describe("Customer, Owner & Admin Rental Management APIs (Commit 12)", () => {
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

  const customerAId = new ObjectId().toString();
  const customerBId = "better-auth-customer-bob";
  const owner1Id = new ObjectId().toString();
  const owner2Id = "better-auth-owner-two";
  const adminId = new ObjectId().toString();

  const eqOwner1AId = new ObjectId();
  const eqOwner1BId = new ObjectId();
  const eqOwner2Id = new ObjectId();

  const b1Id = new ObjectId();
  const b2Id = new ObjectId();
  const b3Id = new ObjectId();
  const b4Id = new ObjectId();

  async function signUserJwt(userId, role) {
    return new SignJWT({ role })
      .setProtectedHeader({ alg: "RS256", kid: "rental-mgr-key-1" })
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
    publicJwk.kid = "rental-mgr-key-1";
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

    const bookingsCollectionGetter = async () => ({
      aggregate(pipeline = []) {
        return {
          async toArray() {
            return runPipeline(bookingsDb, pipeline, {
              [COLLECTIONS.EQUIPMENT]: equipmentDb,
              [COLLECTIONS.PAYMENTS]: paymentsDb,
            });
          },
        };
      },
    });

    const equipmentCollectionGetter = async () => ({
      find(filter = {}) {
        return {
          async toArray() {
            return equipmentDb.filter((d) => matchesFilter(d, filter));
          },
        };
      },
    });

    const usersCollectionGetter = async () => ({
      find(filter = {}) {
        return {
          async toArray() {
            return usersDb.filter((u) => matchesFilter(u, filter));
          },
        };
      },
    });

    const bookingService = createBookingService({
      bookingsCollectionGetter,
      paymentsCollectionGetter: async () => ({}),
    });
    const ownerService = createOwnerRentalService({
      bookingsCollectionGetter,
      equipmentCollectionGetter,
      usersCollectionGetter,
    });
    const adminService = createAdminRentalService({
      bookingsCollectionGetter,
      usersCollectionGetter,
    });

    const app = express();
    app.use(express.json());
    app.use(
      "/api/bookings",
      createBookingRouter({
        authMiddleware: verifyToken,
        renterMiddleware: verifyRenter,
        controller: createBookingController(bookingService),
      })
    );
    app.use(
      "/api/owner",
      createOwnerRouter({
        authMiddleware: verifyToken,
        ownerMiddleware: verifyOwner,
        rentalController: createOwnerRentalController(ownerService),
      })
    );
    app.use(
      "/api/admin",
      createAdminRouter({
        authMiddleware: verifyToken,
        adminMiddleware: verifyAdmin,
        rentalController: createAdminRentalController(adminService),
      })
    );
    app.use(notFound);
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

    usersDb.push(
      { _id: new ObjectId(customerAId), name: "Alice Renter", email: "alice@test.com", image: "https://img/alice.png", passwordHash: "SECRET_HASH", role: USER_ROLES.CUSTOMER },
      { _id: customerBId, id: customerBId, name: "Bob Contractor", email: "bob@test.com", image: null, passwordHash: "SECRET_HASH", role: USER_ROLES.CUSTOMER },
      { _id: new ObjectId(owner1Id), name: "Hasan Heavy Gear", email: "owner1@test.com", image: "https://img/owner1.png", passwordHash: "SECRET_HASH", role: USER_ROLES.OWNER },
      { _id: owner2Id, id: owner2Id, name: "Karim Cinema Rentals", email: "owner2@test.com", image: null, passwordHash: "SECRET_HASH", role: USER_ROLES.OWNER },
      { _id: new ObjectId(adminId), name: "Super Admin", email: "admin@test.com", role: USER_ROLES.ADMIN }
    );

    equipmentDb.push(
      { _id: eqOwner1AId, name: "CAT Mini Excavator 302", category: "Construction Equipment", location: "Uttara Depot", image: "https://img/cat.jpg", rentalType: "Daily", rentalPrice: 8500, ownerId: owner1Id, status: EQUIPMENT_STATUSES.APPROVED },
      { _id: eqOwner1BId, name: "Honda 20kVA Generator", category: "Construction Equipment", location: "Mirpur Yard", image: "https://img/gen.jpg", rentalType: "Weekly", rentalPrice: 12000, ownerId: owner1Id, status: EQUIPMENT_STATUSES.APPROVED },
      { _id: eqOwner2Id, name: "Sony FX6 Cinema Rig", category: "Photography Equipment", location: "Gulshan Studio", image: "https://img/fx6.jpg", rentalType: "Daily", rentalPrice: 6000, ownerId: owner2Id, status: EQUIPMENT_STATUSES.APPROVED }
    );

    bookingsDb.push(
      // b1: Customer A + Owner 1 (CAT Mini Excavator) - oldest created, highest amount
      {
        _id: b1Id,
        customerId: customerAId,
        ownerId: owner1Id,
        equipmentId: eqOwner1AId,
        startDate: new Date("2026-12-01T00:00:00.000Z"),
        endDate: new Date("2026-12-05T00:00:00.000Z"),
        quantity: 2,
        rentalType: "Daily",
        rentalPrice: 8500,
        totalAmount: 85000,
        currency: "bdt",
        paymentStatus: PAYMENT_STATUSES.PAID,
        bookingStatus: BOOKING_STATUSES.CONFIRMED,
        contactNumber: "01711111111",
        deliveryAddress: "Uttara Sector 11",
        additionalNotes: "Call driver on arrival",
        createdAt: new Date("2026-11-18T10:00:00.000Z"),
      },
      // b2: Customer B + Owner 1 (Generator), intentionally omits ownerId to test equipment-owner fallback!
      {
        _id: b2Id,
        customerId: customerBId,
        equipmentId: eqOwner1BId,
        startDate: new Date("2026-11-28T00:00:00.000Z"),
        endDate: new Date("2026-12-04T00:00:00.000Z"),
        quantity: 1,
        rentalType: "Weekly",
        rentalPrice: 12000,
        totalAmount: 12000,
        currency: "bdt",
        paymentStatus: PAYMENT_STATUSES.PAID,
        bookingStatus: BOOKING_STATUSES.ACTIVE,
        contactNumber: "01822222222",
        deliveryAddress: "Dhanmondi 27",
        additionalNotes: "",
        createdAt: new Date("2026-11-20T10:00:00.000Z"),
      },
      // b3: Customer A + Owner 2 (Sony FX6) - middle created, lowest amount, earliest start
      {
        _id: b3Id,
        customerId: customerAId,
        ownerId: owner2Id,
        equipmentId: eqOwner2Id,
        startDate: new Date("2026-11-25T00:00:00.000Z"),
        endDate: new Date("2026-11-26T00:00:00.000Z"),
        quantity: 1,
        rentalType: "Daily",
        rentalPrice: 6000,
        totalAmount: 12000,
        currency: "bdt",
        paymentStatus: PAYMENT_STATUSES.REFUNDED,
        bookingStatus: BOOKING_STATUSES.CANCELLED,
        contactNumber: "01711111111",
        deliveryAddress: "Banani Studio",
        additionalNotes: "",
        createdAt: new Date("2026-11-19T10:00:00.000Z"),
      },
      // b4: Customer B + Owner 2 (Sony FX6) - newest created
      {
        _id: b4Id,
        customerId: customerBId,
        ownerId: owner2Id,
        equipmentId: eqOwner2Id,
        startDate: new Date("2026-12-10T00:00:00.000Z"),
        endDate: new Date("2026-12-12T00:00:00.000Z"),
        quantity: 2,
        rentalType: "Daily",
        rentalPrice: 6000,
        totalAmount: 36000,
        currency: "bdt",
        paymentStatus: PAYMENT_STATUSES.PAID,
        bookingStatus: BOOKING_STATUSES.COMPLETED,
        contactNumber: "01822222222",
        deliveryAddress: "Gulshan Ave",
        additionalNotes: "",
        createdAt: new Date("2026-11-22T10:00:00.000Z"),
      }
    );

    // Multiple payment attempts for b1Id (Failed attempt + Paid success) -> must NOT duplicate b1Id!
    paymentsDb.push(
      {
        _id: new ObjectId(),
        bookingId: b1Id,
        stripeCheckoutSessionId: "cs_retry_failed",
        stripePaymentIntentId: "pi_retry_failed",
        amount: 85000,
        status: PAYMENT_STATUSES.FAILED,
        createdAt: new Date("2026-11-18T09:50:00.000Z"),
      },
      {
        _id: new ObjectId(),
        bookingId: b1Id,
        stripeCheckoutSessionId: "cs_success_b1",
        stripePaymentIntentId: "pi_success_b1",
        amount: 85000,
        status: PAYMENT_STATUSES.PAID,
        paidAt: new Date("2026-11-18T10:01:00.000Z"),
        createdAt: new Date("2026-11-18T10:01:00.000Z"),
      },
      {
        _id: new ObjectId(),
        bookingId: b3Id,
        stripeCheckoutSessionId: "cs_refund_b3",
        stripePaymentIntentId: "pi_refund_b3",
        amount: 12000,
        status: PAYMENT_STATUSES.REFUNDED,
        paidAt: new Date("2026-11-19T10:01:00.000Z"),
        createdAt: new Date("2026-11-19T10:01:00.000Z"),
      }
    );

    // Temporary intent awaiting payment must NEVER appear in finalized rentals
    bookingIntentsDb.push({
      _id: new ObjectId(),
      customerId: customerAId,
      ownerId: owner1Id,
      equipmentId: eqOwner1AId,
      status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
      totalAmount: 99999,
    });
  });

  test("RBAC & DATA ISOLATION: Customer, Owner & Admin boundaries strictly enforced", async () => {
    const custAToken = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);
    const owner1Token = await signUserJwt(owner1Id, USER_ROLES.OWNER);
    const adminToken = await signUserJwt(adminId, USER_ROLES.ADMIN);

    // Unauthenticated denied across all 6 endpoints -> 401
    for (const path of [
      "/api/bookings/my",
      `/api/bookings/${b1Id.toString()}`,
      "/api/owner/rentals",
      `/api/owner/rentals/${b1Id.toString()}`,
      "/api/admin/rentals",
      `/api/admin/rentals/${b1Id.toString()}`,
    ]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 401);
    }

    // Wrong roles denied cleanly -> 403
    for (const [token, path] of [
      [owner1Token, "/api/bookings/my"],
      [adminToken, "/api/bookings/my"],
      [custAToken, "/api/owner/rentals"],
      [adminToken, "/api/owner/rentals"],
      [custAToken, "/api/admin/rentals"],
      [owner1Token, "/api/admin/rentals"],
    ]) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403);
    }

    // Customer A gets ONLY b1Id and b3Id; cannot access b2Id (Customer B) -> 404
    let res = await fetch(`${baseUrl}/api/bookings/my`, {
      headers: { Authorization: `Bearer ${custAToken}` },
    });
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 2);
    assert.equal(json.pagination.totalItems, 2);
    assert.ok(json.data.every((r) => [b1Id.toString(), b3Id.toString()].includes(r._id)));
    // Multiple payment attempts on b1Id did NOT duplicate booking row and selected authoritative Paid payment!
    const b1Row = json.data.find((r) => r._id === b1Id.toString());
    assert.equal(b1Row.paymentStatus, PAYMENT_STATUSES.PAID);

    res = await fetch(`${baseUrl}/api/bookings/${b2Id.toString()}`, {
      headers: { Authorization: `Bearer ${custAToken}` },
    });
    assert.equal(res.status, 404);

    // Customer booking details returns authoritative Paid payment intent & delivery info without owner PII
    res = await fetch(`${baseUrl}/api/bookings/${b1Id.toString()}`, {
      headers: { Authorization: `Bearer ${custAToken}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.transactionId, "pi_success_b1");
    assert.equal(json.data.durationDays, 5);
    assert.equal(json.data.deliveryAddress, "Uttara Sector 11");
    assert.equal(json.data.ownerId, undefined);

    // Owner 1 gets ONLY b1Id and b2Id (matching legacy omitting ownerId via equipmentId fallback!); cannot access Owner 2's b3Id -> 404
    res = await fetch(`${baseUrl}/api/owner/rentals`, {
      headers: { Authorization: `Bearer ${owner1Token}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 2);
    assert.equal(json.pagination.totalItems, 2);
    assert.ok(json.data.some((r) => r._id === b2Id.toString()));
    assert.equal(json.summary.totalBookings, 2);

    const b1OwnerRow = json.data.find((r) => r._id === b1Id.toString());
    assert.equal(b1OwnerRow.customer.name, "Alice Renter");
    assert.equal(b1OwnerRow.customer.passwordHash, undefined);
    assert.equal(b1OwnerRow.equipment.name, "CAT Mini Excavator 302");

    res = await fetch(`${baseUrl}/api/owner/rentals/${b3Id.toString()}`, {
      headers: { Authorization: `Bearer ${owner1Token}` },
    });
    assert.equal(res.status, 404);

    res = await fetch(`${baseUrl}/api/owner/rentals/${b1Id.toString()}`, {
      headers: { Authorization: `Bearer ${owner1Token}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.contactNumber, "01711111111");
    assert.equal(json.data.deliveryAddress, "Uttara Sector 11");
    assert.equal(json.data.additionalNotes, "Call driver on arrival");

    // Admin sees ALL 4 finalized rentals (0 temp bookingIntents), Customer + Owner + Equipment + Payment joins, 0 passwordHashes!
    res = await fetch(`${baseUrl}/api/admin/rentals`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 4);
    assert.equal(json.pagination.totalItems, 4);
    assert.equal(json.data.some((r) => r.bookingStatus === "PendingPayment"), false);

    // Admin rental details returns full authorized reconciliation fields & no passwords
    res = await fetch(`${baseUrl}/api/admin/rentals/${b1Id.toString()}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.customer.name, "Alice Renter");
    assert.equal(json.data.customer.email, "alice@test.com");
    assert.equal(json.data.owner.name, "Hasan Heavy Gear");
    assert.equal(json.data.equipment.location, "Uttara Depot");
    assert.equal(json.data.stripeCheckoutSessionId, "cs_success_b1");
    assert.equal(json.data.paymentIntentId, "pi_success_b1");
    assert.equal(json.data.customer.passwordHash, undefined);

    // Manual admin rental status override is not invented -> returns 404
    const statusPatchRes = await fetch(
      `${baseUrl}/api/admin/rentals/${b1Id.toString()}/status`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bookingStatus: "Completed", paymentStatus: "Paid" }),
      }
    );
    assert.equal(statusPatchRes.status, 404);
  });

  test("SEARCH, STATUS FILTERS, SORTING, PAGINATION & INPUT VALIDATION", async () => {
    const custAToken = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);
    const owner1Token = await signUserJwt(owner1Id, USER_ROLES.OWNER);
    const adminToken = await signUserJwt(adminId, USER_ROLES.ADMIN);

    // 1. Search by Equipment name, Customer name (Owner), Owner name (Admin), Booking ID
    let res = await fetch(`${baseUrl}/api/bookings/my?search=${b1Id.toString()}`, {
      headers: { Authorization: `Bearer ${custAToken}` },
    });
    assert.equal((await res.json()).data.length, 1);

    res = await fetch(`${baseUrl}/api/owner/rentals?search=Bob`, {
      headers: { Authorization: `Bearer ${owner1Token}` },
    });
    let json = await res.json();
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0]._id, b2Id.toString());

    res = await fetch(`${baseUrl}/api/admin/rentals?search=Karim`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(json.data.length, 2);
    assert.ok(json.data.every((r) => r.owner.name === "Karim Cinema Rentals"));

    // Regex metacharacters escaped cleanly without crash
    res = await fetch(`${baseUrl}/api/admin/rentals?search=${encodeURIComponent("CAT.*+?^$")}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.length, 0);

    // 2. Booking Status, Payment Status, Equipment, Customer & Owner filters
    res = await fetch(
      `${baseUrl}/api/admin/rentals?bookingStatus=Active&paymentStatus=Paid&equipmentId=${eqOwner1BId.toString()}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0]._id, b2Id.toString());

    res = await fetch(
      `${baseUrl}/api/admin/rentals?customerId=${encodeURIComponent(customerBId)}&ownerId=${encodeURIComponent(owner2Id)}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    json = await res.json();
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0]._id, b4Id.toString());

    // 3. Invalid filters, PendingPayment status on finalized query, invalid IDs, operator injection, bad limit > 50
    for (const badQuery of [
      "/api/admin/rentals?bookingStatus=PendingPayment",
      "/api/admin/rentals?bookingStatus=Unknown",
      "/api/admin/rentals?paymentStatus=NotReal",
      "/api/admin/rentals?sort=random",
      "/api/admin/rentals?limit=51",
      "/api/admin/rentals?page=0",
      "/api/owner/rentals?equipmentId=bad-object-id",
      "/api/admin/rentals?bookingStatus[$ne]=Cancelled",
    ]) {
      const badRes = await fetch(`${baseUrl}${badQuery}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      // For owner bad equipmentId use owner token
      const checkRes = badQuery.startsWith("/api/owner")
        ? await fetch(`${baseUrl}${badQuery}`, {
            headers: { Authorization: `Bearer ${owner1Token}` },
          })
        : badRes;
      assert.equal(checkRes.status, 400);
    }

    // 4. Sorting checks across newest, oldest, amount_asc, amount_desc, start_date, end_date
    const verifyOrder = async (sort, expectedFirstId) => {
      const r = await fetch(`${baseUrl}/api/admin/rentals?sort=${sort}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.data[0]._id, expectedFirstId.toString());
    };
    await verifyOrder("newest", b4Id);
    await verifyOrder("oldest", b1Id);
    await verifyOrder("amount_asc", b3Id);
    await verifyOrder("amount_desc", b1Id);
    await verifyOrder("start_date", b3Id);
    await verifyOrder("end_date", b3Id);

    // 5. Server-side pagination accuracy + out-of-range page handling
    res = await fetch(`${baseUrl}/api/admin/rentals?sort=newest&page=2&limit=2`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.length, 2);
    assert.deepEqual(json.pagination, {
      currentPage: 2,
      limit: 2,
      totalItems: 4,
      totalPages: 2,
    });

    res = await fetch(`${baseUrl}/api/admin/rentals?page=9&limit=2`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(json.data, []);
    assert.equal(json.pagination.totalItems, 4);

    // 6. Verify required Commit 12 database indexes & idempotency
    const bookingIdxNames = COLLECTION_INDEX_SPECS[COLLECTIONS.BOOKINGS].map(
      (s) => s.options.name
    );
    for (const reqIdx of [
      "bookings_customer_created_idx",
      "bookings_owner_created_idx",
      "bookings_start_date_idx",
      "bookings_end_date_idx",
    ]) {
      assert.ok(bookingIdxNames.includes(reqIdx));
    }

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
    const r1 = await ensureDatabaseCollectionsAndIndexes(mockDb);
    const r2 = await ensureDatabaseCollectionsAndIndexes(mockDb);
    assert.ok(r1.indexesCreated > 0);
    assert.equal(r2.indexesCreated, 0);
  });
});
