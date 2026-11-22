import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

import { createApp } from "../src/app.js";
import { COLLECTION_INDEX_SPECS } from "../src/config/dbIndexes.js";
import { clearRemoteJWKSetCache, verifyJwtAccessToken } from "../src/config/jwks.js";
import { BOOKING_INTENT_STATUSES, BOOKING_STATUSES } from "../src/constants/booking.js";
import { EQUIPMENT_STATUSES } from "../src/constants/equipment.js";
import { PAYMENT_STATUSES } from "../src/constants/payment.js";
import { USER_ROLES } from "../src/constants/roles.js";
import { createPaymentWebhookController } from "../src/controllers/paymentWebhook.controller.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { verifyRenter } from "../src/middleware/verifyRoles.js";
import { createVerifyTokenMiddleware } from "../src/middleware/verifyToken.js";
import { COLLECTIONS } from "../src/models/collections.js";
import { createPaymentController, createPaymentRouter } from "../src/routes/payment.routes.js";
import { createBookingFinalizationService } from "../src/services/bookingFinalization.service.js";
import { createPaymentService } from "../src/services/payment.service.js";
import { createStripeWebhookService } from "../src/services/stripeWebhook.service.js";

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
    if (v && typeof v === "object" && !(v instanceof ObjectId) && !(v instanceof Date)) {
      if ("$ne" in v && String(doc[k]) === String(v.$ne)) return false;
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

describe("Stripe Webhook Processing, Confirmation & Status API (Commit 11)", () => {
  const realStripeSigner = new Stripe("sk_test_fakewebhook123456");
  const testWebhookSecret = "whsec_test_gearnest_secret_1234567890abcdef";

  let issuer;
  let jwksServer;
  let webhookAppServer;
  let webhookBaseUrl;
  let statusAppServer;
  let statusBaseUrl;
  let privateKey;

  let usersDb = [];
  let equipmentDb = [];
  let bookingIntentsDb = [];
  let bookingsDb = [];
  let paymentsDb = [];
  let webhookEventsDb = [];

  let txControl = {
    failOnPaymentInsert: false,
    failStripeSessionRetrieve: false,
    failDbEventLookup: false,
    standaloneError: false,
    transactionsEnabled: true,
    overrideSecret: testWebhookSecret,
  };

  let stripeStore = {
    sessions: new Map(),
    paymentIntents: new Map(),
  };

  let fixedNow = new Date("2026-11-22T12:15:00.000Z");

  const customerAId = new ObjectId().toString();
  const customerBId = "better-auth-customer-b-id";
  const ownerId = new ObjectId().toString();
  const equipmentId = new ObjectId();

  const intentId = new ObjectId();
  const validSessionId = "cs_test_webhook_1234567890";
  const validPiId = "pi_3test_webhook_9876543210";

  async function signUserJwt(userId, role = USER_ROLES.CUSTOMER) {
    return new SignJWT({ role })
      .setProtectedHeader({ alg: "RS256", kid: "wh-key-1" })
      .setIssuer(issuer)
      .setAudience(issuer)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("20m")
      .sign(privateKey);
  }

  function buildSignedWebhookRequest(eventPayloadObj, { secret = testWebhookSecret, timestamp } = {}) {
    const payloadString = JSON.stringify(eventPayloadObj);
    const sigHeader = realStripeSigner.webhooks.generateTestHeaderString({
      payload: payloadString,
      secret,
      ...(timestamp ? { timestamp } : {}),
    });
    return { payloadString, sigHeader };
  }

  function makeFakeStripeClient() {
    return {
      webhooks: {
        constructEvent(rawBody, signature, secret) {
          return realStripeSigner.webhooks.constructEvent(rawBody, signature, secret);
        },
      },
      checkout: {
        sessions: {
          async retrieve(id) {
            if (txControl.failStripeSessionRetrieve) {
              throw new Error("Stripe API temporary network error");
            }
            const s = stripeStore.sessions.get(id);
            if (!s) throw new Error(`No such session ${id}`);
            return { ...s };
          },
        },
      },
      paymentIntents: {
        async retrieve(id) {
          const pi = stripeStore.paymentIntents.get(id);
          if (!pi) throw new Error(`No such payment_intent ${id}`);
          return { ...pi };
        },
      },
    };
  }

  function makeCollectionAccessors() {
    const resolve = (live, session, key) =>
      session?.txState ? session.txState[key] : live;

    return {
      bookingsCollectionGetter: async () => ({
        async findOne(filter, options = {}) {
          const store = resolve(bookingsDb, options.session, "bookings");
          return store.find((d) => matchesFilter(d, filter)) || null;
        },
        async insertOne(doc, options = {}) {
          const store = resolve(bookingsDb, options.session, "bookings");
          if (
            doc.bookingIntentId &&
            store.some((b) => String(b.bookingIntentId) === String(doc.bookingIntentId))
          ) {
            const err = new Error("E11000 duplicate key bookings_booking_intent_unique");
            err.code = 11000;
            throw err;
          }
          const _id = doc._id || new ObjectId();
          store.push({ ...doc, _id });
          return { insertedId: _id };
        },
      }),
      paymentsCollectionGetter: async () => ({
        async findOne(filter, options = {}) {
          const store = resolve(paymentsDb, options.session, "payments");
          return store.find((d) => matchesFilter(d, filter)) || null;
        },
        async insertOne(doc, options = {}) {
          if (txControl.failOnPaymentInsert) {
            txControl.failOnPaymentInsert = false;
            throw new Error("Simulated transient payment insert crash");
          }
          const store = resolve(paymentsDb, options.session, "payments");
          if (
            doc.stripeCheckoutSessionId &&
            store.some((p) => p.stripeCheckoutSessionId === doc.stripeCheckoutSessionId)
          ) {
            const err = new Error("E11000 duplicate key payments_stripe_checkout_session_unique");
            err.code = 11000;
            throw err;
          }
          const _id = doc._id || new ObjectId();
          store.push({ ...doc, _id });
          return { insertedId: _id };
        },
      }),
      bookingIntentsCollectionGetter: async () => ({
        async findOne(filter, options = {}) {
          const store = resolve(bookingIntentsDb, options.session, "intents");
          return store.find((d) => matchesFilter(d, filter)) || null;
        },
        async updateOne(filter, update, options = {}) {
          const store = resolve(bookingIntentsDb, options.session, "intents");
          const found = store.find((d) => matchesFilter(d, filter));
          if (!found) return { modifiedCount: 0 };
          if (update?.$set) Object.assign(found, update.$set);
          if (update?.$unset) {
            for (const k of Object.keys(update.$unset)) delete found[k];
          }
          return { modifiedCount: 1 };
        },
      }),
      webhookEventsCollectionGetter: async () => ({
        async findOne(filter, options = {}) {
          if (txControl.failDbEventLookup) {
            throw new Error("MongoDB connection lost cleanly during event check");
          }
          const store = resolve(webhookEventsDb, options.session, "events");
          return store.find((d) => matchesFilter(d, filter)) || null;
        },
        async insertOne(doc, options = {}) {
          const store = resolve(webhookEventsDb, options.session, "events");
          if (store.some((e) => e.stripeEventId === doc.stripeEventId)) {
            const err = new Error("E11000 duplicate key stripe_webhook_events_event_id_unique");
            err.code = 11000;
            throw err;
          }
          const _id = doc._id || new ObjectId();
          store.push({ ...doc, _id });
          return { insertedId: _id };
        },
        async updateOne(filter, update, options = {}) {
          const store = resolve(webhookEventsDb, options.session, "events");
          const found = store.find((d) => matchesFilter(d, filter));
          if (!found) return { modifiedCount: 0 };
          if (update?.$set) Object.assign(found, update.$set);
          return { modifiedCount: 1 };
        },
      }),
      mongoClientGetter: () => ({
        startSession() {
          const session = {
            txState: null,
            async withTransaction(fn) {
              if (txControl.standaloneError) {
                const err = new Error("Transaction numbers are only allowed on a replica set");
                err.code = 20;
                err.codeName = "IllegalOperation";
                throw err;
              }
              session.txState = {
                bookings: bookingsDb.map((d) => ({ ...d })),
                payments: paymentsDb.map((d) => ({ ...d })),
                intents: bookingIntentsDb.map((d) => ({ ...d })),
                events: webhookEventsDb.map((d) => ({ ...d })),
              };
              try {
                const out = await fn();
                bookingsDb.splice(0, bookingsDb.length, ...session.txState.bookings);
                paymentsDb.splice(0, paymentsDb.length, ...session.txState.payments);
                bookingIntentsDb.splice(0, bookingIntentsDb.length, ...session.txState.intents);
                webhookEventsDb.splice(0, webhookEventsDb.length, ...session.txState.events);
                return out;
              } catch (err) {
                session.txState = null;
                throw err;
              }
            },
            async endSession() {
              session.txState = null;
            },
          };
          return session;
        },
      }),
    };
  }

  before(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    publicJwk.kid = "wh-key-1";
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

    const cols = makeCollectionAccessors();
    const fakeStripe = makeFakeStripeClient();

    const finalizationService = createBookingFinalizationService({
      bookingsCollectionGetter: cols.bookingsCollectionGetter,
      paymentsCollectionGetter: cols.paymentsCollectionGetter,
      bookingIntentsCollectionGetter: cols.bookingIntentsCollectionGetter,
      webhookEventsCollectionGetter: cols.webhookEventsCollectionGetter,
      mongoClientGetter: cols.mongoClientGetter,
      nowProvider: () => new Date(fixedNow.getTime()),
      transactionsEnabled: true,
    });

    const webhookService = createStripeWebhookService({
      stripeClientGetter: () => fakeStripe,
      currencyResolver: () => "bdt",
      webhookSecretResolver: () => txControl.overrideSecret,
      bookingIntentsCollectionGetter: cols.bookingIntentsCollectionGetter,
      webhookEventsCollectionGetter: cols.webhookEventsCollectionGetter,
      finalizationService,
      nowProvider: () => new Date(fixedNow.getTime()),
    });

    const webhookController = createPaymentWebhookController(webhookService);

    // Mount real createApp() with raw-body webhook handler BEFORE express.json()!
    const fullApp = createApp({
      webhookHandler: webhookController.handleWebhook,
    });
    webhookAppServer = http.createServer(fullApp);
    await new Promise((resolve) => webhookAppServer.listen(0, "127.0.0.1", resolve));
    webhookBaseUrl = `http://127.0.0.1:${webhookAppServer.address().port}`;

    // Separate app testing pre-parsed JSON rejection & Customer GET /api/payments/session/:sessionId
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

    const paymentService = createPaymentService({
      paymentsCollectionGetter: cols.paymentsCollectionGetter,
      bookingsCollectionGetter: cols.bookingsCollectionGetter,
      bookingIntentsCollectionGetter: cols.bookingIntentsCollectionGetter,
      equipmentCollectionGetter: async () => ({
        async findOne(filter) {
          return equipmentDb.find((d) => matchesFilter(d, filter)) || null;
        },
      }),
      nowProvider: () => new Date(fixedNow.getTime()),
    });

    const statusApp = express();
    statusApp.use(express.json());
    // Intentionally parses JSON BEFORE webhook handler to prove pre-parsed body gets rejected!
    statusApp.post("/api/payments/webhook-parsed", webhookController.handleWebhook);
    statusApp.use(
      "/api/payments",
      createPaymentRouter({
        authMiddleware: verifyToken,
        renterMiddleware: verifyRenter,
        controller: createPaymentController(paymentService),
      })
    );
    statusApp.use(errorHandler);

    statusAppServer = http.createServer(statusApp);
    await new Promise((resolve) => statusAppServer.listen(0, "127.0.0.1", resolve));
    statusBaseUrl = `http://127.0.0.1:${statusAppServer.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => webhookAppServer.close(resolve));
    await new Promise((resolve) => statusAppServer.close(resolve));
    await new Promise((resolve) => jwksServer.close(resolve));
  });

  beforeEach(() => {
    usersDb.length = 0;
    equipmentDb.length = 0;
    bookingIntentsDb.length = 0;
    bookingsDb.length = 0;
    paymentsDb.length = 0;
    webhookEventsDb.length = 0;
    stripeStore.sessions.clear();
    stripeStore.paymentIntents.clear();
    txControl = {
      failOnPaymentInsert: false,
      failStripeSessionRetrieve: false,
      failDbEventLookup: false,
      standaloneError: false,
      transactionsEnabled: true,
      overrideSecret: testWebhookSecret,
    };

    usersDb.push(
      { _id: new ObjectId(customerAId), name: "Customer A", email: "a@test.com", role: USER_ROLES.CUSTOMER },
      { _id: customerBId, id: customerBId, name: "Customer B", email: "b@test.com", role: USER_ROLES.CUSTOMER },
      { _id: new ObjectId(ownerId), name: "Owner", email: "o@test.com", role: USER_ROLES.OWNER }
    );

    equipmentDb.push({
      _id: equipmentId,
      name: "Mini Excavator",
      image: "https://i.ibb.co/example/excavator.jpg",
      category: "Construction Equipment",
      rentalType: "Daily",
      rentalPrice: 8500,
      availableQuantity: 5,
      ownerId,
      status: EQUIPMENT_STATUSES.APPROVED,
    });

    bookingIntentsDb.push({
      _id: intentId,
      customerId: customerAId,
      ownerId,
      equipmentId,
      startDate: new Date("2026-11-24T00:00:00.000Z"),
      endDate: new Date("2026-11-26T00:00:00.000Z"),
      quantity: 2,
      contactNumber: "01711111111",
      deliveryAddress: "Sector 7, Uttara, Dhaka",
      additionalNotes: "Deliver at gate 2",
      rentalType: "Daily",
      rentalPrice: 8500,
      billableUnits: 3,
      totalAmount: 51000,
      currency: "bdt",
      stripeCheckoutSessionId: validSessionId,
      status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
      expiresAt: new Date(fixedNow.getTime() + 20 * 60 * 1000),
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });

    stripeStore.sessions.set(validSessionId, {
      id: validSessionId,
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      currency: "bdt",
      amount_total: 5100000,
      client_reference_id: intentId.toString(),
      payment_intent: validPiId,
      metadata: {
        bookingIntentId: intentId.toString(),
        customerId: customerAId,
        ownerId,
        equipmentId: equipmentId.toString(),
      },
    });

    stripeStore.paymentIntents.set(validPiId, {
      id: validPiId,
      status: "succeeded",
      currency: "bdt",
      amount: 5100000,
      amount_received: 5100000,
      created: Math.floor(fixedNow.getTime() / 1000),
    });
  });

  test("SIGNATURE & RAW BUFFER TESTS: Missing, tampered, wrong secret, parsed JSON & expired timestamp rejected", async () => {
    const sampleEvent = {
      id: "evt_sig_1",
      type: "checkout.session.completed",
      data: { object: { id: validSessionId } },
    };
    const { payloadString, sigHeader } = buildSignedWebhookRequest(sampleEvent);

    // 1. Missing stripe-signature header -> 400
    let res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payloadString,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).message, "Invalid Stripe webhook signature");

    // 2. Invalid signature header -> 400
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=123,v1=deadbeef",
      },
      body: payloadString,
    });
    assert.equal(res.status, 400);

    // 3. Modified payload after signing -> 400
    const tamperedPayload = payloadString.replace("evt_sig_1", "evt_sig_tampered");
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": sigHeader,
      },
      body: tamperedPayload,
    });
    assert.equal(res.status, 400);

    // 4. Signed with wrong webhook secret -> 400
    const wrongSig = buildSignedWebhookRequest(sampleEvent, {
      secret: "whsec_wrong_secret_9999999999999999",
    });
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": wrongSig.sigHeader,
      },
      body: wrongSig.payloadString,
    });
    assert.equal(res.status, 400);

    // 5. Expired signature timestamp (outside Stripe 300s tolerance) -> 400
    const staleTimestamp = Math.floor(Date.now() / 1000) - 900;
    const staleSig = buildSignedWebhookRequest(sampleEvent, {
      timestamp: staleTimestamp,
    });
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": staleSig.sigHeader,
      },
      body: staleSig.payloadString,
    });
    assert.equal(res.status, 400);

    // 6. Missing webhook secret config -> 503
    txControl.overrideSecret = "";
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": sigHeader,
      },
      body: payloadString,
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).message, "Webhook configuration unavailable");
    txControl.overrideSecret = testWebhookSecret;

    // 7. Parsed JSON middleware before webhook rejects non-Buffer body -> 400
    res = await fetch(`${statusBaseUrl}/api/payments/webhook-parsed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": sigHeader,
      },
      body: payloadString,
    });
    assert.equal(res.status, 400);
    assert.equal(bookingsDb.length, 0);
  });

  test("CHECKOUT FINALIZATION, TRANSACTION ROLLBACK & IDEMPOTENCY RETRIES", async () => {
    const event = {
      id: "evt_complete_1",
      type: "checkout.session.completed",
      data: { object: { id: validSessionId } },
    };
    const { payloadString, sigHeader } = buildSignedWebhookRequest(event);

    // 1. Simulated DB failure mid-transaction rolls back BOTH booking AND webhookEvent!
    txControl.failOnPaymentInsert = true;
    let res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": sigHeader,
      },
      body: payloadString,
    });
    assert.equal(res.status, 500);
    assert.equal(bookingsDb.length, 0);
    assert.equal(paymentsDb.length, 0);
    assert.equal(webhookEventsDb.length, 0);
    assert.equal(bookingIntentsDb[0].status, BOOKING_INTENT_STATUSES.PENDING_PAYMENT);

    // 2. Stripe retry succeeds atomically -> creates 1 final booking, 1 payment, converts intent
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": sigHeader,
      },
      body: payloadString,
    });
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.message, "Webhook processed successfully");

    assert.equal(bookingsDb.length, 1);
    assert.equal(paymentsDb.length, 1);
    assert.equal(webhookEventsDb.length, 1);

    const createdBooking = bookingsDb[0];
    assert.equal(String(createdBooking.bookingIntentId), intentId.toString());
    assert.equal(createdBooking.customerId, customerAId);
    assert.equal(createdBooking.ownerId, ownerId);
    assert.equal(String(createdBooking.equipmentId), equipmentId.toString());
    assert.equal(createdBooking.quantity, 2);
    assert.equal(createdBooking.totalAmount, 51000);
    assert.equal(createdBooking.currency, "bdt");
    assert.equal(createdBooking.paymentStatus, PAYMENT_STATUSES.PAID);
    assert.equal(createdBooking.bookingStatus, BOOKING_STATUSES.CONFIRMED);

    const createdPayment = paymentsDb[0];
    assert.equal(String(createdPayment.bookingId), String(createdBooking._id));
    assert.equal(createdPayment.stripeCheckoutSessionId, validSessionId);
    assert.equal(createdPayment.stripePaymentIntentId, validPiId);
    assert.equal(createdPayment.amount, 51000);
    assert.equal(createdPayment.amountMinor, 5100000);
    assert.equal(createdPayment.currency, "bdt");
    assert.equal(createdPayment.status, PAYMENT_STATUSES.PAID);
    assert.ok(createdPayment.paidAt instanceof Date);

    assert.equal(bookingIntentsDb[0].status, BOOKING_INTENT_STATUSES.CONVERTED);
    assert.equal(String(bookingIntentsDb[0].finalBookingId), String(createdBooking._id));
    assert.equal(bookingIntentsDb[0].expiresAt, undefined);
    assert.equal(webhookEventsDb[0].processed, true);

    // 3. Duplicate event delivery returns 200 idempotently with 0 duplicate inserts
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": sigHeader,
      },
      body: payloadString,
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.message, "Webhook event already processed");
    assert.equal(bookingsDb.length, 1);
    assert.equal(paymentsDb.length, 1);

    // 4. Different event ID referencing same already-converted intent also blocked
    const dupEvent = {
      id: "evt_complete_duplicate_different_id",
      type: "checkout.session.async_payment_succeeded",
      data: { object: { id: validSessionId } },
    };
    const dupSigned = buildSignedWebhookRequest(dupEvent);
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": dupSigned.sigHeader,
      },
      body: dupSigned.payloadString,
    });
    assert.equal(res.status, 200);
    assert.equal(bookingsDb.length, 1);
    assert.equal(paymentsDb.length, 1);

    // 5. Out-of-order expiration or failure events AFTER conversion never downgrade confirmed booking
    for (const [eid, etype] of [
      ["evt_late_expire", "checkout.session.expired"],
      ["evt_late_fail", "checkout.session.async_payment_failed"],
    ]) {
      const lateSigned = buildSignedWebhookRequest({
        id: eid,
        type: etype,
        data: { object: { id: validSessionId } },
      });
      res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": lateSigned.sigHeader,
        },
        body: lateSigned.payloadString,
      });
      assert.equal(res.status, 200);
      assert.equal(bookingIntentsDb[0].status, BOOKING_INTENT_STATUSES.CONVERTED);
      assert.equal(bookingsDb[0].bookingStatus, BOOKING_STATUSES.CONFIRMED);
      assert.equal(bookingsDb[0].paymentStatus, PAYMENT_STATUSES.PAID);
    }
  });

  test("EVENT VALIDATION, DELAYED PAYMENT, FAILURE, EXPIRATION & UNIQUE CONSTRAINTS", async () => {
    // 1. Delayed payment: completed session with payment_status: "unpaid" keeps hold pending, later async_payment_succeeded finalizes!
    stripeStore.sessions.get(validSessionId).payment_status = "unpaid";
    const delayedComplete = buildSignedWebhookRequest({
      id: "evt_unpaid_first",
      type: "checkout.session.completed",
      data: { object: { id: validSessionId } },
    });
    let res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": delayedComplete.sigHeader,
      },
      body: delayedComplete.payloadString,
    });
    assert.equal(res.status, 200);
    assert.equal(bookingsDb.length, 0);
    assert.equal(bookingIntentsDb[0].status, BOOKING_INTENT_STATUSES.PENDING_PAYMENT);

    // Delayed async payment arrives -> finalizes cleanly
    stripeStore.sessions.get(validSessionId).payment_status = "paid";
    const asyncSuccess = buildSignedWebhookRequest({
      id: "evt_async_paid",
      type: "checkout.session.async_payment_succeeded",
      data: { object: { id: validSessionId } },
    });
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": asyncSuccess.sigHeader,
      },
      body: asyncSuccess.payloadString,
    });
    assert.equal(res.status, 200);
    assert.equal(bookingsDb.length, 1);

    // Reset state to test failure, expiry, mismatches, and unsupported events on fresh intents
    bookingsDb.length = 0;
    paymentsDb.length = 0;
    bookingIntentsDb[0].status = BOOKING_INTENT_STATUSES.PENDING_PAYMENT;
    bookingIntentsDb[0].expiresAt = new Date(fixedNow.getTime() + 600000);
    delete bookingIntentsDb[0].finalBookingId;

    // 2. Mismatched amount_total -> audited as rejected, ZERO booking created
    stripeStore.sessions.get(validSessionId).amount_total = 100;
    const badAmount = buildSignedWebhookRequest({
      id: "evt_bad_amt",
      type: "checkout.session.completed",
      data: { object: { id: validSessionId } },
    });
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": badAmount.sigHeader,
      },
      body: badAmount.payloadString,
    });
    assert.equal(res.status, 200);
    assert.equal(bookingsDb.length, 0);
    assert.equal(
      webhookEventsDb.find((e) => e.stripeEventId === "evt_bad_amt").status,
      "rejected_amount_or_currency_mismatch"
    );

    // Restore correct amount, break PaymentIntent status
    stripeStore.sessions.get(validSessionId).amount_total = 5100000;
    stripeStore.paymentIntents.get(validPiId).status = "requires_payment_method";
    const badPi = buildSignedWebhookRequest({
      id: "evt_bad_pi",
      type: "checkout.session.completed",
      data: { object: { id: validSessionId } },
    });
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": badPi.sigHeader,
      },
      body: badPi.payloadString,
    });
    assert.equal(res.status, 200);
    assert.equal(bookingsDb.length, 0);
    stripeStore.paymentIntents.get(validPiId).status = "succeeded";

    // 3. Unsupported event type acknowledged & ignored
    const unsupported = buildSignedWebhookRequest({
      id: "evt_other_1",
      type: "payment_intent.created",
      data: { object: { id: validPiId } },
    });
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": unsupported.sigHeader,
      },
      body: unsupported.payloadString,
    });
    assert.equal(res.status, 200);
    assert.equal(bookingsDb.length, 0);

    // 4. Async payment failed updates intent to Failed and clears reservation hold
    const asyncFail = buildSignedWebhookRequest({
      id: "evt_async_fail_1",
      type: "checkout.session.async_payment_failed",
      data: { object: { id: validSessionId } },
    });
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": asyncFail.sigHeader,
      },
      body: asyncFail.payloadString,
    });
    assert.equal(res.status, 200);
    assert.equal(bookingIntentsDb[0].status, BOOKING_INTENT_STATUSES.FAILED);
    assert.equal(bookingIntentsDb[0].paymentStatus, PAYMENT_STATUSES.FAILED);
    assert.equal(bookingsDb.length, 0);

    // 5. Checkout expired releases PendingPayment intent -> Expired
    bookingIntentsDb[0].status = BOOKING_INTENT_STATUSES.PENDING_PAYMENT;
    bookingIntentsDb[0].expiresAt = new Date(fixedNow.getTime() + 60000);
    const expiredEvt = buildSignedWebhookRequest({
      id: "evt_expired_1",
      type: "checkout.session.expired",
      data: { object: { id: validSessionId } },
    });
    res = await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": expiredEvt.sigHeader,
      },
      body: expiredEvt.payloadString,
    });
    assert.equal(res.status, 200);
    assert.equal(bookingIntentsDb[0].status, BOOKING_INTENT_STATUSES.EXPIRED);

    // 6. Verify unique DB index constraints on bookings, payments & webhook events
    assert.ok(
      COLLECTION_INDEX_SPECS[COLLECTIONS.BOOKINGS].some(
        (s) => s.key?.bookingIntentId === 1 && s.options?.unique === true
      )
    );
    assert.ok(
      COLLECTION_INDEX_SPECS[COLLECTIONS.STRIPE_WEBHOOK_EVENTS].some(
        (s) => s.key?.stripeEventId === 1 && s.options?.unique === true
      )
    );
  });

  test("CUSTOMER PAYMENT STATUS RETRIEVAL API & READ-ONLY ISOLATION", async () => {
    const tokenA = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);
    const tokenB = await signUserJwt(customerBId, USER_ROLES.CUSTOMER);
    const tokenOwner = await signUserJwt(ownerId, USER_ROLES.OWNER);

    // 1. Unauthenticated / wrong role rejected
    let res = await fetch(`${statusBaseUrl}/api/payments/session/${validSessionId}`);
    assert.equal(res.status, 401);

    res = await fetch(`${statusBaseUrl}/api/payments/session/${validSessionId}`, {
      headers: { Authorization: `Bearer ${tokenOwner}` },
    });
    assert.equal(res.status, 403);

    // 2. Invalid session ID format -> 400
    res = await fetch(`${statusBaseUrl}/api/payments/session/invalid$id!`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 400);

    // 3. Before webhook runs: GET status reads Pending/PendingPayment WITHOUT confirming payment or inserting booking!
    res = await fetch(`${statusBaseUrl}/api/payments/session/${validSessionId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.paymentStatus, PAYMENT_STATUSES.PENDING);
    assert.equal(json.data.bookingStatus, BOOKING_INTENT_STATUSES.PENDING_PAYMENT);
    assert.equal(json.data.verified, false);
    assert.equal(bookingsDb.length, 0);
    assert.equal(paymentsDb.length, 0);

    // 4. Customer B cannot read Customer A's checkout session -> 404
    res = await fetch(`${statusBaseUrl}/api/payments/session/${validSessionId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(res.status, 404);

    // 5. After verified webhook runs -> GET status returns Paid + Confirmed + bookingId + transactionId
    const signed = buildSignedWebhookRequest({
      id: "evt_for_status_check",
      type: "checkout.session.completed",
      data: { object: { id: validSessionId } },
    });
    await fetch(`${webhookBaseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": signed.sigHeader,
      },
      body: signed.payloadString,
    });

    res = await fetch(`${statusBaseUrl}/api/payments/session/${validSessionId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.sessionId, validSessionId);
    assert.equal(json.data.bookingId, String(bookingsDb[0]._id));
    assert.equal(json.data.equipmentName, "Mini Excavator");
    assert.equal(json.data.paymentStatus, PAYMENT_STATUSES.PAID);
    assert.equal(json.data.bookingStatus, BOOKING_STATUSES.CONFIRMED);
    assert.equal(json.data.totalAmount, 51000);
    assert.equal(json.data.currency, "bdt");
    assert.equal(json.data.transactionId, validPiId);
    assert.equal(json.data.verified, true);
  });
});
