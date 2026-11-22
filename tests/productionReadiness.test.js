import assert from "node:assert/strict";
import { describe, test } from "node:test";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { ObjectId } from "mongodb";

import { BOOKING_STATUSES } from "../src/constants/booking.js";
import { PAYMENT_STATUSES } from "../src/constants/payment.js";
import { USER_ROLES } from "../src/constants/roles.js";
import { createCorsOptions } from "../src/config/cors.js";
import { redactMongoUri } from "../src/config/env.js";
import { createMailer, resolveMailConfig } from "../src/config/mailer.js";
import { createContactController } from "../src/controllers/contact.controller.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { notFound } from "../src/middleware/notFound.js";
import { createRateLimiter } from "../src/middleware/rateLimiter.js";
import { seedInitialAdmin } from "../src/scripts/seedAdmin.js";
import { createContactRouter } from "../src/routes/contact.routes.js";
import healthRouter from "../src/routes/health.routes.js";
import { createBookingLifecycleCronService } from "../src/services/bookingLifecycleCron.service.js";
import { createContactService } from "../src/services/contact.service.js";
import { createEmailNotificationService } from "../src/services/emailNotification.service.js";

function matchesSimple(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or") {
      if (!v.some((sub) => matchesSimple(doc, sub))) return false;
      continue;
    }
    if (v && typeof v === "object" && !(v instanceof Date) && !(v instanceof ObjectId) && !Array.isArray(v)) {
      if ("$exists" in v) {
        const exists = doc[k] !== undefined;
        if (exists !== v.$exists) return false;
      }
      if ("$in" in v) {
        if (!v.$in.some((item) => String(doc[k]) === String(item))) return false;
      }
      if ("$lt" in v) {
        if (!(doc[k] instanceof Date ? doc[k].getTime() < v.$lt.getTime() : doc[k] < v.$lt)) {
          return false;
        }
      }
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

function createMutableCollectionStub(rowsRef) {
  return {
    async insertOne(doc) {
      const _id = doc._id || new ObjectId();
      const stored = { ...doc, _id };
      rowsRef.push(stored);
      return { acknowledged: true, insertedId: _id };
    },
    async findOne(filter = {}) {
      return rowsRef.find((d) => matchesSimple(d, filter)) || null;
    },
    find(filter = {}) {
      const matched = rowsRef.filter((d) => matchesSimple(d, filter));
      return {
        async toArray() {
          return matched;
        },
      };
    },
    async findOneAndUpdate(filter, update, options = {}) {
      const idx = rowsRef.findIndex((d) => matchesSimple(d, filter));
      if (idx === -1) return null;
      const before = { ...rowsRef[idx] };
      if (update?.$set) {
        rowsRef[idx] = { ...rowsRef[idx], ...update.$set };
      }
      return options.returnDocument === "after" ? { ...rowsRef[idx] } : before;
    },
    async updateOne(filter, update) {
      const idx = rowsRef.findIndex((d) => matchesSimple(d, filter));
      if (idx === -1) return { matchedCount: 0, modifiedCount: 0 };
      if (update?.$set) {
        rowsRef[idx] = { ...rowsRef[idx], ...update.$set };
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

describe("Commit 15: Contact API, Bootstrap, Cron/Mailer & Production Readiness", () => {
  test("POST /api/contact validates, sanitizes, persists status New without faking email, and enforces 429 rate limiting", async () => {
    const contactMessages = [];
    const limiter = createRateLimiter({
      windowMs: 60000,
      max: 5,
      keyPrefix: "test-contact",
      message: "Too many contact messages submitted from this IP.",
    });

    const contactService = createContactService({
      contactMessagesCollectionGetter: async () =>
        createMutableCollectionStub(contactMessages),
    });

    const app = express();
    app.use(express.json({ limit: "20kb" }));
    app.use(
      "/api/contact",
      createContactRouter({
        rateLimiter: limiter,
        controller: createContactController(contactService),
      })
    );
    app.use(errorHandler);

    let server;
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      // Invalid & unsafe payloads rejected cleanly
      for (const badBody of [
        { name: "A", email: "bad-email", inquiryType: "InvalidType", subject: "Hi", message: "Too short" },
        { name: "Customer", email: "cust@example.com", inquiryType: "General Inquiry", subject: "Valid Sub", message: "Message of enough length here", status: "Resolved" },
        { name: "Customer", email: "cust@example.com", inquiryType: "General Inquiry", subject: "Valid Sub", message: "Message of enough length here", $ne: 1 },
      ]) {
        const res = await fetch(`${baseUrl}/api/contact`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(badBody),
        });
        assert.equal(res.status, 400);
      }
      assert.equal(contactMessages.length, 0);

      // Valid submission #1 persists cleanly with default status New
      const validPayload = {
        name: "  Customer Name  ",
        email: "CUSTOMER@Example.COM ",
        inquiryType: "General Inquiry",
        subject: "Rental Question",
        message: "I would like to know more about equipment rental.",
      };

      const res1 = await fetch(`${baseUrl}/api/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validPayload),
      });
      const json1 = await res1.json();
      assert.equal(res1.status, 201);
      assert.equal(json1.success, true);
      assert.equal(json1.data.status, "New");
      assert.equal(json1.data.inquiryType, "General Inquiry");
      assert.equal(contactMessages.length, 1);
      assert.equal(contactMessages[0].email, "customer@example.com");
      assert.equal(contactMessages[0].name, "Customer Name");
      assert.equal(contactMessages[0].status, "New");

      // Valid submission #2 hits cap (max=2)
      const res2 = await fetch(`${baseUrl}/api/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validPayload),
      });
      assert.equal(res2.status, 201);

      // Submission #3 returns 429 Too Many Requests with Retry-After header
      const res3 = await fetch(`${baseUrl}/api/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validPayload),
      });
      const json3 = await res3.json();
      assert.equal(res3.status, 429);
      assert.equal(json3.success, false);
      assert.ok(Number(res3.headers.get("retry-after")) >= 1);
    } finally {
      server?.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  test("seedInitialAdmin provisions via Better Auth signUp mechanism, is idempotent, and refuses silent Customer/Owner promotion", async () => {
    const users = [];
    const usersStub = createMutableCollectionStub(users);
    let signUpCalls = 0;

    const fakeSignUp = async ({ name, email, password }) => {
      signUpCalls += 1;
      assert.ok(password.length >= 6);
      const id = `ba_${signUpCalls}`;
      users.push({
        _id: new ObjectId(),
        id,
        name,
        email,
        role: USER_ROLES.CUSTOMER,
      });
      return { user: { id, name, email, role: USER_ROLES.CUSTOMER } };
    };

    // Rejects weak passwords
    await assert.rejects(
      () =>
        seedInitialAdmin({
          name: "Root Admin",
          email: "admin@gearnest.test",
          password: "weak",
          usersCollectionGetter: async () => usersStub,
          signUpFn: fakeSignUp,
        }),
      /ADMIN_PASSWORD/
    );

    // Creates initial Admin cleanly
    const created = await seedInitialAdmin({
      name: "Root Admin",
      email: "Admin@GearNest.Test",
      password: "StrongPass1",
      usersCollectionGetter: async () => usersStub,
      signUpFn: fakeSignUp,
    });
    assert.equal(created.action, "created");
    assert.equal(created.role, USER_ROLES.ADMIN);
    assert.equal(created.email, "admin@gearnest.test");
    assert.equal(users[0].role, USER_ROLES.ADMIN);
    assert.equal(signUpCalls, 1);

    // Idempotent rerun skips duplicate signup
    const rerun = await seedInitialAdmin({
      name: "Root Admin",
      email: "admin@gearnest.test",
      password: "StrongPass1",
      usersCollectionGetter: async () => usersStub,
      signUpFn: fakeSignUp,
    });
    assert.equal(rerun.action, "already_exists");
    assert.equal(signUpCalls, 1);

    // Refuses silent promotion of existing Customer/Owner
    users.push({
      _id: new ObjectId(),
      id: "cust_existing",
      name: "Existing Owner",
      email: "owner@gearnest.test",
      role: USER_ROLES.OWNER,
    });
    await assert.rejects(
      () =>
        seedInitialAdmin({
          name: "Existing Owner",
          email: "owner@gearnest.test",
          password: "StrongPass1",
          usersCollectionGetter: async () => usersStub,
          signUpFn: fakeSignUp,
        }),
      /role "Owner"/
    );
  });

  test("Optional booking completion cron marks elapsed paid rentals Completed in UTC idempotently and handles optional SMTP notifications safely", async () => {
    const ownerId = "owner_1";
    const customerId = "customer_1";
    const eqId = new ObjectId();

    const users = [
      { _id: new ObjectId(), id: ownerId, name: "Owner One", email: "owner1@gearnest.test", role: USER_ROLES.OWNER },
      { _id: new ObjectId(), id: customerId, name: "Cust One", email: "cust1@gearnest.test", role: USER_ROLES.CUSTOMER },
    ];
    const equipment = [{ _id: eqId, name: "CAT Excavator 320" }];
    const bookings = [
      // Elapsed paid Confirmed booking -> SHOULD become Completed
      {
        _id: new ObjectId(),
        customerId,
        ownerId,
        equipmentId: eqId,
        startDate: new Date("2026-11-18T00:00:00.000Z"),
        endDate: new Date("2026-11-21T00:00:00.000Z"),
        bookingStatus: BOOKING_STATUSES.CONFIRMED,
        paymentStatus: PAYMENT_STATUSES.PAID,
      },
      // Today's endDate -> MUST remain Active (has not passed UTC day boundary yet)
      {
        _id: new ObjectId(),
        customerId,
        ownerId,
        equipmentId: eqId,
        startDate: new Date("2026-11-20T00:00:00.000Z"),
        endDate: new Date("2026-11-22T00:00:00.000Z"),
        bookingStatus: BOOKING_STATUSES.ACTIVE,
        paymentStatus: PAYMENT_STATUSES.PAID,
      },
      // Cancelled past booking -> MUST NOT be modified
      {
        _id: new ObjectId(),
        customerId,
        ownerId,
        equipmentId: eqId,
        startDate: new Date("2026-11-10T00:00:00.000Z"),
        endDate: new Date("2026-11-11T00:00:00.000Z"),
        bookingStatus: BOOKING_STATUSES.CANCELLED,
        paymentStatus: PAYMENT_STATUSES.REFUNDED,
      },
      // Unpaid booking -> MUST NOT be modified
      {
        _id: new ObjectId(),
        customerId,
        ownerId,
        equipmentId: eqId,
        startDate: new Date("2026-11-10T00:00:00.000Z"),
        endDate: new Date("2026-11-11T00:00:00.000Z"),
        bookingStatus: BOOKING_STATUSES.CONFIRMED,
        paymentStatus: PAYMENT_STATUSES.PENDING,
      },
    ];

    const bookingsStub = createMutableCollectionStub(bookings);
    const fixedNow = new Date("2026-11-22T00:05:00.000Z");

    // 1. Without SMTP configured -> degrades gracefully with skipped status
    const unconfiguredMailer = createMailer({
      configResolver: () => ({ configured: false }),
    });
    const notifyServiceUnconfigured = createEmailNotificationService({
      mailer: unconfiguredMailer,
      bookingsCollectionGetter: async () => bookingsStub,
      equipmentCollectionGetter: async () => createMutableCollectionStub(equipment),
      usersCollectionGetter: async () => createMutableCollectionStub(users),
      nowProvider: () => fixedNow,
    });

    const cronUnconfigured = createBookingLifecycleCronService({
      bookingsCollectionGetter: async () => bookingsStub,
      emailNotificationService: notifyServiceUnconfigured,
      nowProvider: () => fixedNow,
      enabled: true,
    });

    const sweep1 = await cronUnconfigured.runCompletedBookingSweep();
    assert.equal(sweep1.updatedCount, 1);
    assert.equal(bookings[0].bookingStatus, BOOKING_STATUSES.COMPLETED);
    assert.ok(bookings[0].completedAt instanceof Date);
    assert.ok(bookings[0].updatedAt instanceof Date);
    assert.equal(bookings[0].completionEmailStatus, "skipped");
    assert.equal(bookings[1].bookingStatus, BOOKING_STATUSES.ACTIVE);
    assert.equal(bookings[2].bookingStatus, BOOKING_STATUSES.CANCELLED);
    assert.equal(bookings[3].bookingStatus, BOOKING_STATUSES.CONFIRMED);

    // Idempotent second run updates 0 bookings
    const sweep2 = await cronUnconfigured.runCompletedBookingSweep();
    assert.equal(sweep2.updatedCount, 0);

    // 2. With mock SMTP configured -> sends exactly once to Customer + Owner & deduplicates retries
    const sentMessages = [];
    const configuredMailer = createMailer({
      nodemailerLib: {
        createTransport: () => ({
          async sendMail(msg) {
            sentMessages.push(msg);
            return { messageId: `msg_${sentMessages.length}` };
          },
        }),
      },
      configResolver: () => ({
        configured: true,
        host: "smtp.example.org",
        port: 587,
        secure: false,
        user: "noreply",
        pass: "secret",
        from: "no-reply@gearnest.example",
      }),
    });

    const bookingForMail = {
      _id: new ObjectId(),
      customerId,
      ownerId,
      equipmentId: eqId,
      startDate: new Date("2026-11-18T00:00:00.000Z"),
      endDate: new Date("2026-11-20T00:00:00.000Z"),
      bookingStatus: BOOKING_STATUSES.COMPLETED,
      paymentStatus: PAYMENT_STATUSES.PAID,
    };
    bookings.push(bookingForMail);

    const notifyServiceConfigured = createEmailNotificationService({
      mailer: configuredMailer,
      bookingsCollectionGetter: async () => bookingsStub,
      equipmentCollectionGetter: async () => createMutableCollectionStub(equipment),
      usersCollectionGetter: async () => createMutableCollectionStub(users),
      nowProvider: () => fixedNow,
    });

    const mailRes1 = await notifyServiceConfigured.notifyBookingCompleted({
      booking: bookingForMail,
    });
    assert.equal(mailRes1.notified, true);
    assert.equal(mailRes1.status, "sent");
    assert.equal(sentMessages.length, 2);

    // Duplicate retry must be blocked atomically
    const mailRes2 = await notifyServiceConfigured.notifyBookingCompleted({
      booking: bookingForMail,
    });
    assert.equal(mailRes2.notified, false);
    assert.equal(mailRes2.status, "already_handled");
    assert.equal(sentMessages.length, 2);

    const mailConfigDefault = resolveMailConfig();
    assert.equal(typeof mailConfigDefault.configured, "boolean");
  });

  test("CORS allowlist, Helmet headers, health/readiness, 404/400/413 envelopes, and secret redaction behave securely", async () => {
    const app = express();
    app.disable("x-powered-by");
    app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
    app.use(cors(createCorsOptions(["https://gearnest.example"])));
    app.use(express.json({ limit: "1kb" }));
    app.use("/api/health", healthRouter);
    app.post("/api/test-echo", (req, res) => res.json({ success: true, data: req.body }));
    app.use(notFound);
    app.use(errorHandler);

    let server;
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      // Allowed origin & preflight OPTIONS
      const preflight = await fetch(`${baseUrl}/api/health`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://gearnest.example",
          "Access-Control-Request-Method": "GET",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "https://gearnest.example");
      assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");

      // Disallowed origin rejected with 403
      const blockedCors = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(blockedCors.status, 403);
      assert.equal(blockedCors.headers.get("access-control-allow-origin"), null);

      // Health liveness 200 & readiness 503 when disconnected
      const healthRes = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.headers.get("x-powered-by"), null);
      assert.ok(healthRes.headers.get("x-content-type-options"));

      const readyRes = await fetch(`${baseUrl}/api/health/ready`);
      assert.equal(readyRes.status, 503);

      // 404, 400 malformed JSON, 413 oversized payload
      assert.equal((await fetch(`${baseUrl}/api/does-not-exist`)).status, 404);
      const badJsonRes = await fetch(`${baseUrl}/api/test-echo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{bad-json",
      });
      assert.equal(badJsonRes.status, 400);

      const largeRes = await fetch(`${baseUrl}/api/test-echo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(4096) }),
      });
      assert.equal(largeRes.status, 413);

      // Credential redaction safety check
      const redacted = redactMongoUri(
        "mongodb+srv://admin:SuperSecret123@cluster.mongodb.net sk_test_51ABC123 whsec_abc999"
      );
      assert.equal(redacted.includes("SuperSecret123"), false);
      assert.equal(redacted.includes("sk_test_51ABC123"), false);
      assert.equal(redacted.includes("whsec_abc999"), false);
    } finally {
      server?.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });
});
