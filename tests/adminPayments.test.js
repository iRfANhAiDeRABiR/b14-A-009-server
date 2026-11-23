import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import express from "express";
import { ObjectId } from "mongodb";

import { errorHandler } from "../src/middleware/errorHandler.js";
import {
  createAdminPaymentController,
  createAdminRouter,
} from "../src/routes/admin.routes.js";
import { createAdminPaymentService } from "../src/services/adminPayment.service.js";

function getPath(doc, path) {
  return path.split(".").reduce((cur, part) => cur?.[part], doc);
}

function matches(doc, filter = {}) {
  for (const [key, val] of Object.entries(filter || {})) {
    if (key === "$or") {
      if (!val.some((sub) => matches(doc, sub))) return false;
      continue;
    }
    if (key === "$and") {
      if (!val.every((sub) => matches(doc, sub))) return false;
      continue;
    }
    const actual = getPath(doc, key);
    if (val && typeof val === "object" && !(val instanceof ObjectId)) {
      if ("$in" in val) {
        if (!val.$in.map(String).includes(String(actual))) return false;
        continue;
      }
      if ("$regex" in val) {
        if (!new RegExp(val.$regex, val.$options || "").test(String(actual ?? ""))) {
          return false;
        }
        continue;
      }
    }
    if (String(actual) !== String(val)) return false;
  }
  return true;
}

function memoryCollection(rows) {
  return {
    async countDocuments(filter = {}) {
      return rows.filter((doc) => matches(doc, filter)).length;
    },
    find(filter = {}) {
      const found = rows.filter((doc) => matches(doc, filter));
      let sortSpec = null;
      let skipN = 0;
      let limitN = found.length;
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
          const cloned = [...found];
          if (sortSpec) {
            cloned.sort((a, b) => {
              for (const [k, dir] of Object.entries(sortSpec)) {
                const va = a[k] instanceof Date ? a[k].getTime() : a[k];
                const vb = b[k] instanceof Date ? b[k].getTime() : b[k];
                const sa = typeof va === "number" ? va : String(va ?? "");
                const sb = typeof vb === "number" ? vb : String(vb ?? "");
                if (sa < sb) return dir === 1 ? -1 : 1;
                if (sa > sb) return dir === 1 ? 1 : -1;
              }
              return 0;
            });
          }
          return cloned.slice(skipN, skipN + limitN);
        },
      };
    },
    aggregate() {
      return {
        async toArray() {
          const groups = new Map();
          for (const row of rows) {
            const g = groups.get(row.status) || { _id: row.status, count: 0, amount: 0 };
            g.count += 1;
            g.amount += Number(row.amount) || 0;
            groups.set(row.status, g);
          }
          return [...groups.values()];
        },
      };
    },
  };
}

describe("Admin Payment History API", () => {
  let server;
  let baseUrl;
  let authMode = "admin";

  const customerId = new ObjectId();
  const customerTwoId = new ObjectId();
  const ownerId = new ObjectId();
  const equipmentId = new ObjectId();
  const bookingId = new ObjectId();

  const users = [
    { _id: customerId, name: "Ayesha Rahman", email: "ayesha@example.com", phone: "01711111111", role: "Customer" },
    { _id: customerTwoId, name: "Tanvir Hasan", email: "tanvir@example.com", role: "Customer" },
    { _id: ownerId, name: "Gear Owner", email: "owner@example.com", role: "Owner" },
  ];
  const equipment = [
    { _id: equipmentId, name: "Compact Hydraulic Mini Excavator", category: "Construction Equipment", image: "https://example.com/e.jpg" },
  ];
  const bookings = [
    {
      _id: bookingId,
      startDate: new Date("2026-12-01"),
      endDate: new Date("2026-12-03"),
      quantity: 2,
      rentalType: "Daily",
      bookingStatus: "Confirmed",
      paymentStatus: "Paid",
      totalAmount: 25000,
      contactNumber: "01711111111",
      deliveryAddress: "Banani, Dhaka",
    },
  ];
  const payments = [
    {
      _id: new ObjectId(),
      bookingId,
      customerId: String(customerId),
      ownerId: String(ownerId),
      equipmentId,
      provider: "stripe",
      stripeCheckoutSessionId: "cs_test_alpha111",
      stripePaymentIntentId: "pi_test_alpha111",
      amount: 25000,
      currency: "bdt",
      status: "Paid",
      paidAt: new Date("2026-11-20T10:00:00Z"),
      createdAt: new Date("2026-11-20T10:00:00Z"),
    },
    {
      _id: new ObjectId(),
      bookingId: new ObjectId(),
      customerId: String(customerTwoId),
      ownerId: String(ownerId),
      equipmentId,
      provider: "stripe",
      stripeCheckoutSessionId: "cs_test_beta222",
      amount: 9000,
      currency: "bdt",
      status: "Refunded",
      paidAt: new Date("2026-11-21T10:00:00Z"),
      createdAt: new Date("2026-11-21T10:00:00Z"),
    },
    {
      _id: new ObjectId(),
      bookingId: new ObjectId(),
      customerId: String(customerId),
      ownerId: String(ownerId),
      equipmentId: new ObjectId(),
      provider: "stripe",
      amount: 4000,
      currency: "bdt",
      status: "Failed",
      paidAt: null,
      createdAt: new Date("2026-11-22T10:00:00Z"),
    },
  ];

  before(async () => {
    const service = createAdminPaymentService({
      paymentsCollectionGetter: async () => memoryCollection(payments),
      usersCollectionGetter: async () => memoryCollection(users),
      equipmentCollectionGetter: async () => memoryCollection(equipment),
      bookingsCollectionGetter: async () => memoryCollection(bookings),
    });

    const app = express();
    app.use(express.json());
    app.use(
      "/api/admin",
      createAdminRouter({
        authMiddleware: (req, res, next) => {
          if (authMode === "anonymous") {
            return res.status(401).json({ success: false, message: "Authentication required" });
          }
          req.user = { id: "admin_pay_01", role: authMode === "customer" ? "Customer" : "Admin" };
          return next();
        },
        adminMiddleware: (req, res, next) => {
          if (req.user?.role !== "Admin") {
            return res.status(403).json({ success: false, message: "Admin access required" });
          }
          return next();
        },
        paymentController: createAdminPaymentController(service),
      })
    );
    app.use(errorHandler);

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function getJson(path) {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, body: await res.json() };
  }

  test("AUTHORIZATION: anonymous gets 401 and non-admin gets 403", async () => {
    authMode = "anonymous";
    assert.equal((await getJson("/api/admin/payments")).status, 401);
    authMode = "customer";
    assert.equal((await getJson("/api/admin/payments")).status, 403);
    authMode = "admin";
  });

  test("LISTING: returns hydrated customer, owner, equipment, booking and Stripe details with summary", async () => {
    const { status, body } = await getJson("/api/admin/payments");
    assert.equal(status, 200);
    assert.equal(body.data.length, 3);
    assert.equal(body.pagination.totalItems, 3);
    assert.deepEqual(body.summary, {
      totalPayments: 3,
      paidCount: 1,
      paidRevenue: 25000,
      pendingCount: 0,
      failedCount: 1,
      refundedCount: 1,
      refundedAmount: 9000,
    });

    // newest first => Failed (Nov 22) leads
    assert.equal(body.data[0].status, "Failed");

    const paid = body.data.find((p) => p.status === "Paid");
    assert.equal(paid.customer.name, "Ayesha Rahman");
    assert.equal(paid.customer.email, "ayesha@example.com");
    assert.equal(paid.customer.phone, "01711111111");
    assert.equal(paid.owner.name, "Gear Owner");
    assert.equal(paid.equipment.name, "Compact Hydraulic Mini Excavator");
    assert.equal(paid.booking.quantity, 2);
    assert.equal(paid.booking.deliveryAddress, "Banani, Dhaka");
    assert.equal(paid.currency, "BDT");
    assert.equal(paid.stripeCheckoutSessionId, "cs_test_alpha111");
    assert.equal(paid.stripePaymentIntentId, "pi_test_alpha111");

    const failed = body.data.find((p) => p.status === "Failed");
    assert.equal(failed.equipment.name, "Removed equipment");
  });

  test("FILTERS: status, customer, search (user/equipment/stripe id), sort and pagination", async () => {
    const refunded = await getJson("/api/admin/payments?status=refunded");
    assert.equal(refunded.body.data.length, 1);
    assert.equal(refunded.body.data[0].customer.name, "Tanvir Hasan");

    const byCustomer = await getJson(`/api/admin/payments?customerId=${customerId}`);
    assert.equal(byCustomer.body.data.length, 2);
    assert.ok(byCustomer.body.data.every((p) => p.customer.email === "ayesha@example.com"));

    const byUser = await getJson("/api/admin/payments?search=tanvir");
    assert.equal(byUser.body.data.length, 1);

    const byEquipment = await getJson("/api/admin/payments?search=excavator");
    assert.equal(byEquipment.body.data.length, 2);

    const byStripe = await getJson("/api/admin/payments?search=cs_test_alpha");
    assert.equal(byStripe.body.data.length, 1);
    assert.equal(byStripe.body.data[0].status, "Paid");

    const none = await getJson("/api/admin/payments?search=nothing-matches-this");
    assert.equal(none.body.data.length, 0);
    assert.equal(none.body.pagination.totalPages, 0);

    const highest = await getJson("/api/admin/payments?sort=amount_high");
    assert.deepEqual(highest.body.data.map((p) => p.amount), [25000, 9000, 4000]);

    const paged = await getJson("/api/admin/payments?limit=2&page=2");
    assert.equal(paged.body.data.length, 1);
    assert.equal(paged.body.pagination.totalPages, 2);
  });

  test("VALIDATION: rejects invalid status, sort, limits, ids and operator injection", async () => {
    for (const query of [
      "status=Bogus",
      "sort=random",
      "limit=500",
      "page=0",
      "customerId=x",
      "status[$ne]=Paid",
      `search=${"a".repeat(101)}`,
    ]) {
      const { status } = await getJson(`/api/admin/payments?${query}`);
      assert.equal(status, 400, `expected 400 for ${query}`);
    }
  });
});
