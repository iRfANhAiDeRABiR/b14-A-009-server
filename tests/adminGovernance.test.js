import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { ObjectId } from "mongodb";

import { errorHandler } from "../src/middleware/errorHandler.js";
import {
  createAdminAuditLogController,
  createAdminEquipmentController,
  createAdminInquiryController,
  createAdminRentalController,
  createAdminRouter,
  createAdminUserController,
} from "../src/routes/admin.routes.js";
import { createAdminInquiryService } from "../src/services/adminInquiry.service.js";
import { createAdminRentalService } from "../src/services/adminRental.service.js";
import { createAdminUserService } from "../src/services/adminUser.service.js";
import { createAuditLogService } from "../src/services/auditLog.service.js";

function matchesSimple(doc, filter = {}) {
  for (const [key, val] of Object.entries(filter || {})) {
    if (key === "$or" && Array.isArray(val)) {
      const ok = val.some((sub) => matchesSimple(doc, sub));
      if (!ok) return false;
      continue;
    }
    if (key === "$and" && Array.isArray(val)) {
      const ok = val.every((sub) => matchesSimple(doc, sub));
      if (!ok) return false;
      continue;
    }
    if (val && typeof val === "object" && !Array.isArray(val) && !(val instanceof ObjectId)) {
      if ("$ne" in val) {
        if (doc[key] === val.$ne) return false;
        continue;
      }
      if ("$in" in val) {
        if (!val.$in.map(String).includes(String(doc[key]))) return false;
        continue;
      }
      if ("$regex" in val) {
        const parts = key.split(".");
        let cur = doc;
        for (const p of parts) cur = cur?.[p];
        const rx = new RegExp(val.$regex, val.$options || "");
        if (!rx.test(String(cur || ""))) return false;
        continue;
      }
    }
    if (String(doc[key]) !== String(val)) return false;
  }
  return true;
}

function createMemoryCollection(rows) {
  return {
    async insertOne(doc) {
      const id = doc._id || new ObjectId();
      const stored = { ...doc, _id: id };
      rows.push(stored);
      return { insertedId: id };
    },
    async findOne(filter) {
      return rows.find((doc) => matchesSimple(doc, filter)) || null;
    },
    async countDocuments(filter = {}) {
      return rows.filter((doc) => matchesSimple(doc, filter)).length;
    },
    find(filter = {}) {
      let matched = rows.filter((doc) => matchesSimple(doc, filter));
      let sortSpec = null;
      let skipN = 0;
      let limitN = matched.length;
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
          const cloned = [...matched];
          if (sortSpec) {
            cloned.sort((a, b) => {
              for (const [k, dir] of Object.entries(sortSpec)) {
                const va = a[k] instanceof Date ? a[k].getTime() : String(a[k] || "");
                const vb = b[k] instanceof Date ? b[k].getTime() : String(b[k] || "");
                if (va < vb) return dir === 1 ? -1 : 1;
                if (va > vb) return dir === 1 ? 1 : -1;
              }
              return 0;
            });
          }
          return cloned.slice(skipN, skipN + limitN);
        },
      };
    },
    async findOneAndUpdate(filter, update) {
      const found = rows.find((doc) => matchesSimple(doc, filter));
      if (!found) return null;
      if (update?.$set) Object.assign(found, update.$set);
      return found;
    },
    async updateOne(filter, update) {
      const found = rows.find((doc) => matchesSimple(doc, filter));
      if (!found) return { modifiedCount: 0 };
      if (update?.$set) Object.assign(found, update.$set);
      return { modifiedCount: 1 };
    },
    async deleteOne(filter) {
      const idx = rows.findIndex((doc) => matchesSimple(doc, filter));
      if (idx === -1) return { deletedCount: 0 };
      rows.splice(idx, 1);
      return { deletedCount: 1 };
    },
    async deleteMany(filter) {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matchesSimple(rows[i], filter)) {
          rows.splice(i, 1);
          count += 1;
        }
      }
      return { deletedCount: count };
    },
    aggregate(pipeline) {
      return {
        async toArray() {
          const matchStage = pipeline.find((s) => "$match" in s)?.$match || {};
          const matched = rows.filter((r) => matchesSimple(r, matchStage));
          return matched;
        },
      };
    },
  };
}

describe("Admin Event Log, User Actions, Rental Status & Support Inquiries", () => {
  let server;
  let baseUrl;
  let usersData;
  let sessionsData;
  let logsData;
  let bookingsData;
  let inquiriesData;

  const adminId = "admin_gov_01";
  const adminSecondId = "admin_gov_02";
  const customerId = "cust_gov_01";
  let rentalOid;
  let inquiryOid;

  before(async () => {
    usersData = [];
    sessionsData = [];
    logsData = [];
    bookingsData = [];
    inquiriesData = [];

    const auditService = createAuditLogService({
      auditLogsCollectionGetter: async () => createMemoryCollection(logsData),
    });

    const userService = createAdminUserService({
      usersCollectionGetter: async () => createMemoryCollection(usersData),
      sessionsCollectionGetter: async () => createMemoryCollection(sessionsData),
      auditLogger: (p) => auditService.recordEventSafely(p),
    });

    const inquiryService = createAdminInquiryService({
      contactMessagesCollectionGetter: async () =>
        createMemoryCollection(inquiriesData),
      auditLogger: (p) => auditService.recordEventSafely(p),
    });

    const rentalService = createAdminRentalService({
      bookingsCollectionGetter: async () => createMemoryCollection(bookingsData),
      usersCollectionGetter: async () => createMemoryCollection(usersData),
      auditLogger: (p) => auditService.recordEventSafely(p),
    });

    const app = express();
    app.use(express.json());

    const fakeAuth = (req, _res, next) => {
      req.user = {
        id: adminId,
        name: "Platform Admin",
        email: "admin@gearnest.app",
        role: "Admin",
      };
      next();
    };
    const fakeAdmin = (_req, _res, next) => next();

    app.use(
      "/api/admin",
      createAdminRouter({
        authMiddleware: fakeAuth,
        adminMiddleware: fakeAdmin,
        controller: createAdminUserController(userService),
        rentalController: createAdminRentalController(rentalService),
        equipmentController: createAdminEquipmentController({}),
        auditLogController: createAdminAuditLogController(auditService),
        inquiryController: createAdminInquiryController(inquiryService),
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

  beforeEach(() => {
    logsData.length = 0;
    rentalOid = new ObjectId();
    inquiryOid = new ObjectId();

    usersData.splice(
      0,
      usersData.length,
      {
        _id: adminId,
        id: adminId,
        name: "Platform Admin",
        email: "admin@gearnest.app",
        role: "Admin",
        createdAt: new Date(),
      },
      {
        _id: adminSecondId,
        id: adminSecondId,
        name: "Backup Admin",
        email: "backup@gearnest.app",
        role: "Admin",
        createdAt: new Date(),
      },
      {
        _id: customerId,
        id: customerId,
        name: "Target Customer",
        email: "cust@example.com",
        role: "Customer",
        createdAt: new Date(),
      }
    );

    sessionsData.splice(0, sessionsData.length, {
      _id: "sess_1",
      userId: customerId,
    });

    bookingsData.splice(0, bookingsData.length, {
      _id: rentalOid,
      customerId,
      ownerId: adminSecondId,
      equipmentId: new ObjectId(),
      startDate: new Date("2026-12-01T00:00:00Z"),
      endDate: new Date("2026-12-03T00:00:00Z"),
      quantity: 1,
      rentalType: "Daily",
      rentalPrice: 2000,
      totalAmount: 6000,
      currency: "BDT",
      paymentStatus: "Paid",
      bookingStatus: "Confirmed",
      createdAt: new Date(),
    });

    inquiriesData.splice(0, inquiriesData.length, {
      _id: inquiryOid,
      name: "Samira Hossain",
      email: "samira@example.com",
      inquiryType: "Equipment Rental",
      subject: "Need excavator invoice copy",
      message: "Please share VAT invoice for booking #8821.",
      status: "New",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  test("User status suspend/reactivate, metadata edit, session revocation & audit logs", async () => {
    // Suspend customer & revoke sessions
    const suspendRes = await fetch(`${baseUrl}/api/admin/users/${customerId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "Suspended", reason: "Overdue return" }),
    });
    assert.equal(suspendRes.status, 200);
    const suspendJson = await suspendRes.json();
    assert.equal(suspendJson.data.accountStatus, "Suspended");
    assert.equal(sessionsData.length, 0);

    // Self-suspend must be blocked
    const selfRes = await fetch(`${baseUrl}/api/admin/users/${adminId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "Suspended" }),
    });
    assert.equal(selfRes.status, 400);

    // Edit user details
    const editRes = await fetch(`${baseUrl}/api/admin/users/${customerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Target Customer Updated", phone: "+8801711111111" }),
    });
    assert.equal(editRes.status, 200);
    const editJson = await editRes.json();
    assert.equal(editJson.data.name, "Target Customer Updated");

    // Soft-delete user
    const delRes = await fetch(`${baseUrl}/api/admin/users/${customerId}`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);

    // Verify deleted user excluded from user list
    const listRes = await fetch(`${baseUrl}/api/admin/users`);
    const listJson = await listRes.json();
    assert.equal(listJson.data.some((u) => u.id === customerId), false);

    // Verify audit log captured all 3 actions
    const logRes = await fetch(`${baseUrl}/api/admin/logs?category=user`);
    assert.equal(logRes.status, 200);
    const logJson = await logRes.json();
    const actions = logJson.data.map((entry) => entry.action);
    assert.ok(actions.includes("USER_SUSPENDED"));
    assert.ok(actions.includes("USER_UPDATED"));
    assert.ok(actions.includes("USER_DELETED"));
  });

  test("Rental governance note & Inquiry inbox CRUD + audit logs", async () => {
    // Update admin governance note without overriding Stripe-backed rental statuses
    const noteRes = await fetch(
      `${baseUrl}/api/admin/rentals/${rentalOid}/note`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminNote: "Verified pickup docs" }),
      }
    );
    assert.equal(noteRes.status, 200);
    assert.equal((await noteRes.json()).data.adminNote, "Verified pickup docs");

    // Manual bookingStatus override on /note rejected cleanly 400
    const invalidRes = await fetch(
      `${baseUrl}/api/admin/rentals/${rentalOid}/note`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingStatus: "Completed" }),
      }
    );
    assert.equal(invalidRes.status, 400);

    // Inquiries list -> update status -> delete
    const inqList = await fetch(`${baseUrl}/api/admin/inquiries?status=New`);
    assert.equal(inqList.status, 200);
    assert.equal((await inqList.json()).data.length, 1);

    const inqPatch = await fetch(
      `${baseUrl}/api/admin/inquiries/${inquiryOid}/status`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "Resolved", adminNote: "Invoice emailed" }),
      }
    );
    assert.equal(inqPatch.status, 200);
    assert.equal((await inqPatch.json()).data.status, "Resolved");

    const inqDel = await fetch(`${baseUrl}/api/admin/inquiries/${inquiryOid}`, {
      method: "DELETE",
    });
    assert.equal(inqDel.status, 200);

    // Audit log contains rental note & inquiry actions
    const logsRes = await fetch(`${baseUrl}/api/admin/logs`);
    const logsJson = await logsRes.json();
    const actions = logsJson.data.map((e) => e.action);
    assert.ok(actions.includes("RENTAL_NOTE_UPDATED"));
    assert.ok(actions.includes("INQUIRY_STATUS_UPDATED"));
    assert.ok(actions.includes("INQUIRY_DELETED"));
  });
});
