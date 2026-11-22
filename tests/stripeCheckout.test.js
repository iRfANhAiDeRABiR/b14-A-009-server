import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ObjectId } from "mongodb";

import { clearRemoteJWKSetCache, verifyJwtAccessToken } from "../src/config/jwks.js";
import {
  clearStripeConfigurationCache,
  getStripeClient,
  resolveCheckoutClientUrl,
  resolveStripeCurrency,
  resolveStripeSecretKey,
  verifyStripeAccountCurrencyEligibility,
} from "../src/config/stripe.js";
import { BOOKING_INTENT_STATUSES } from "../src/constants/booking.js";
import { EQUIPMENT_STATUSES } from "../src/constants/equipment.js";
import { USER_ROLES } from "../src/constants/roles.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { verifyRenter } from "../src/middleware/verifyRoles.js";
import { createVerifyTokenMiddleware } from "../src/middleware/verifyToken.js";
import { createPaymentController, createPaymentRouter } from "../src/routes/payment.routes.js";
import { createPaymentService } from "../src/services/payment.service.js";
import { createStripeCheckoutService } from "../src/services/stripeCheckout.service.js";
import { convertToStripeMinorUnits } from "../src/utils/currency.js";

function matchesFilter(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$and") {
      if (!v.every((clause) => matchesFilter(doc, clause))) return false;
      continue;
    }
    if (k === "$or") {
      if (!v.some((clause) => matchesFilter(doc, clause))) return false;
      continue;
    }
    if (v && typeof v === "object" && !(v instanceof ObjectId) && !(v instanceof Date)) {
      if ("$exists" in v) {
        const exists = doc[k] !== undefined;
        if (Boolean(v.$exists) !== exists) return false;
      }
      if ("$gt" in v) {
        const dv = doc[k] instanceof Date ? doc[k].getTime() : Number(doc[k]);
        const rv = v.$gt instanceof Date ? v.$gt.getTime() : Number(v.$gt);
        if (!(dv > rv)) return false;
      }
      if ("$lte" in v) {
        const dv = doc[k] instanceof Date ? doc[k].getTime() : Number(doc[k]);
        const rv = v.$lte instanceof Date ? v.$lte.getTime() : Number(v.$lte);
        if (!(dv <= rv)) return false;
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

describe("Stripe Hosted Checkout Session Integration (Commit 10)", () => {
  let issuer;
  let jwksServer;
  let apiServer;
  let baseUrl;
  let privateKey;

  let usersDb = [];
  let equipmentDb = [];
  let bookingIntentsDb = [];
  let finalizedBookingsDb = [];
  let paymentsDb = [];

  let fixedNow = new Date("2026-11-22T12:00:00.000Z");

  let stripeMockState;

  const customerAId = new ObjectId().toString();
  const customerBId = "better-auth-customer-b-id";
  const ownerId = new ObjectId().toString();
  const adminId = new ObjectId().toString();

  const equipmentApprovedId = new ObjectId();
  const equipmentPendingId = new ObjectId();
  const validIntentId = new ObjectId();
  const expiredIntentId = new ObjectId();
  const convertedIntentId = new ObjectId();
  const otherCustomerIntentId = new ObjectId();

  async function signUserJwt(userId, role = USER_ROLES.CUSTOMER) {
    return new SignJWT({ role })
      .setProtectedHeader({ alg: "RS256", kid: "checkout-key-1" })
      .setIssuer(issuer)
      .setAudience(issuer)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("20m")
      .sign(privateKey);
  }

  function resetStripeMock() {
    stripeMockState = {
      sessionsById: new Map(),
      createCalls: [],
      retrieveCalls: [],
      expireCalls: [],
      currencySupported: true,
      failNextCreateWith: null,
      failNextDbUpdate: false,
      delayCreateMs: 0,
      fakeCounter: 1,
    };
  }

  function makeFakeStripeClient() {
    return {
      accounts: {
        async retrieve() {
          return { country: "BD", default_currency: "bdt" };
        },
      },
      countrySpecs: {
        async retrieve() {
          return {
            supported_payment_currencies: stripeMockState.currencySupported
              ? ["bdt", "usd"]
              : ["usd"],
          };
        },
      },
      checkout: {
        sessions: {
          async create(params, options = {}) {
            if (stripeMockState.delayCreateMs > 0) {
              await new Promise((r) => setTimeout(r, stripeMockState.delayCreateMs));
            }
            if (stripeMockState.failNextCreateWith) {
              const err = stripeMockState.failNextCreateWith;
              stripeMockState.failNextCreateWith = null;
              throw err;
            }
            const key = options?.idempotencyKey;
            stripeMockState.createCalls.push({ params, options });

            // Simulate Stripe idempotency cache for identical idempotencyKey
            const existingByKey = [...stripeMockState.sessionsById.values()].find(
              (s) => s._idempotencyKey === key
            );
            if (existingByKey) {
              return existingByKey;
            }

            const seq = stripeMockState.fakeCounter++;
            const id = `cs_test_a1B2c3D4e5F6g7H8_${seq}`;
            const session = {
              id,
              url: `https://checkout.stripe.com/c/pay/${id}#fidkdWxOYHwn`,
              status: "open",
              payment_status: "unpaid",
              expires_at: params.expires_at,
              params,
              _idempotencyKey: key,
            };
            stripeMockState.sessionsById.set(id, session);
            return session;
          },
          async retrieve(id) {
            stripeMockState.retrieveCalls.push(id);
            const session = stripeMockState.sessionsById.get(id);
            if (!session) {
              const err = new Error(`No such checkout.session: '${id}'`);
              err.type = "StripeInvalidRequestError";
              throw err;
            }
            return session;
          },
          async expire(id) {
            stripeMockState.expireCalls.push(id);
            const session = stripeMockState.sessionsById.get(id);
            if (session) {
              session.status = "expired";
            }
            return session || { id, status: "expired" };
          },
        },
      },
    };
  }

  before(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    publicJwk.kid = "checkout-key-1";
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

    const stripeClient = makeFakeStripeClient();

    const checkoutService = createStripeCheckoutService({
      bookingIntentsCollectionGetter: async () => ({
        async findOne(filter) {
          const found = bookingIntentsDb.find((d) => matchesFilter(d, filter));
          return found ? { ...found } : null;
        },
        async findOneAndUpdate(filter, update) {
          const found = bookingIntentsDb.find((d) => matchesFilter(d, filter));
          if (!found) return null;
          if (update?.$set) Object.assign(found, update.$set);
          if (update?.$unset) {
            for (const key of Object.keys(update.$unset)) delete found[key];
          }
          return { ...found };
        },
        async updateOne(filter, update) {
          if (stripeMockState.failNextDbUpdate) {
            stripeMockState.failNextDbUpdate = false;
            throw new Error("Simulated MongoDB write failure after Stripe create");
          }
          const found = bookingIntentsDb.find((d) => matchesFilter(d, filter));
          if (!found) return { modifiedCount: 0 };
          if (update?.$set) Object.assign(found, update.$set);
          if (update?.$unset) {
            for (const key of Object.keys(update.$unset)) delete found[key];
          }
          return { modifiedCount: 1 };
        },
      }),
      equipmentCollectionGetter: async () => ({
        async findOne(filter) {
          const found = equipmentDb.find((d) => matchesFilter(d, filter));
          return found ? { ...found } : null;
        },
      }),
      usersCollectionGetter: async () => ({
        async findOne(filter) {
          return usersDb.find((u) => matchesFilter(u, filter)) || null;
        },
      }),
      stripeClientGetter: () => stripeClient,
      currencyResolver: () => resolveStripeCurrency("bdt"),
      clientUrlResolver: () => resolveCheckoutClientUrl("http://localhost:3000", false),
      currencyEligibilityVerifier: async (client, currency) => {
        if (!stripeMockState.currencySupported) {
          await verifyStripeAccountCurrencyEligibility(client, currency, {
            bypassCache: true,
          });
        }
        return verifyStripeAccountCurrencyEligibility(client, currency, {
          bypassCache: true,
        });
      },
      checkoutExpireMinutesResolver: () => 30,
      nowProvider: () => new Date(fixedNow.getTime()),
    });

    const service = createPaymentService({ checkoutService });

    const app = express();
    app.use(express.json());
    app.use(
      "/api/payments",
      createPaymentRouter({
        authMiddleware: verifyToken,
        renterMiddleware: verifyRenter,
        controller: createPaymentController(service),
      })
    );
    app.use(errorHandler);

    apiServer = http.createServer(app);
    await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
  });

  after(async () => {
    clearStripeConfigurationCache();
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => jwksServer.close(resolve));
  });

  beforeEach(() => {
    clearStripeConfigurationCache();
    resetStripeMock();
    usersDb.length = 0;
    equipmentDb.length = 0;
    bookingIntentsDb.length = 0;
    finalizedBookingsDb.length = 0;
    paymentsDb.length = 0;
    fixedNow = new Date("2026-11-22T12:00:00.000Z");

    usersDb.push(
      { _id: new ObjectId(customerAId), name: "Customer A", email: "customer.a@gearnest.test", role: USER_ROLES.CUSTOMER },
      { _id: customerBId, id: customerBId, name: "Customer B", email: "customer.b@gearnest.test", role: USER_ROLES.CUSTOMER },
      { _id: new ObjectId(ownerId), name: "Owner", email: "owner@gearnest.test", role: USER_ROLES.OWNER },
      { _id: new ObjectId(adminId), name: "Admin", email: "admin@gearnest.test", role: USER_ROLES.ADMIN }
    );

    equipmentDb.push(
      {
        _id: equipmentApprovedId,
        name: "CAT Mini Excavator 302",
        category: "Construction Equipment",
        rentalType: "Daily",
        rentalPrice: 8500,
        availableQuantity: 5,
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.APPROVED,
      },
      {
        _id: equipmentPendingId,
        name: "Pending Generator",
        category: "Construction Equipment",
        rentalType: "Daily",
        rentalPrice: 4000,
        availableQuantity: 2,
        ownerId: new ObjectId(ownerId),
        status: EQUIPMENT_STATUSES.PENDING,
      }
    );

    bookingIntentsDb.push(
      {
        _id: validIntentId,
        customerId: customerAId,
        ownerId,
        equipmentId: equipmentApprovedId,
        startDate: new Date("2026-11-24T00:00:00.000Z"),
        endDate: new Date("2026-11-26T00:00:00.000Z"),
        quantity: 2,
        rentalType: "Daily",
        rentalPrice: 8500,
        billableUnits: 3,
        totalAmount: 51000,
        currency: "BDT",
        status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
        expiresAt: new Date(fixedNow.getTime() + 10 * 60 * 1000),
        createdAt: fixedNow,
        updatedAt: fixedNow,
      },
      {
        _id: expiredIntentId,
        customerId: customerAId,
        ownerId,
        equipmentId: equipmentApprovedId,
        startDate: new Date("2026-11-24T00:00:00.000Z"),
        endDate: new Date("2026-11-26T00:00:00.000Z"),
        quantity: 1,
        rentalType: "Daily",
        rentalPrice: 8500,
        billableUnits: 3,
        totalAmount: 25500,
        currency: "BDT",
        status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
        expiresAt: new Date(fixedNow.getTime() - 60 * 1000),
      },
      {
        _id: convertedIntentId,
        customerId: customerAId,
        ownerId,
        equipmentId: equipmentApprovedId,
        startDate: new Date("2026-11-24T00:00:00.000Z"),
        endDate: new Date("2026-11-26T00:00:00.000Z"),
        quantity: 1,
        rentalType: "Daily",
        rentalPrice: 8500,
        billableUnits: 3,
        totalAmount: 25500,
        currency: "BDT",
        status: BOOKING_INTENT_STATUSES.CONVERTED,
        expiresAt: new Date(fixedNow.getTime() + 60 * 1000),
      },
      {
        _id: otherCustomerIntentId,
        customerId: customerBId,
        ownerId,
        equipmentId: equipmentApprovedId,
        startDate: new Date("2026-11-24T00:00:00.000Z"),
        endDate: new Date("2026-11-26T00:00:00.000Z"),
        quantity: 1,
        rentalType: "Daily",
        rentalPrice: 8500,
        billableUnits: 3,
        totalAmount: 25500,
        currency: "BDT",
        status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
        expiresAt: new Date(fixedNow.getTime() + 600 * 1000),
      }
    );
  });

  test("CONFIGURATION & CURRENCY UTILITIES: Secret keys, account currency eligibility & minor-unit math", async () => {
    // 1. Singleton Stripe client caching + missing/invalid secret rejection
    const c1 = getStripeClient({ secretKey: "sk_test_fakekey12345678" });
    const c2 = getStripeClient({ secretKey: "sk_test_fakekey12345678" });
    assert.equal(c1, c2);

    assert.throws(() => resolveStripeSecretKey(""), /Payment service is currently unavailable/);
    assert.throws(() => resolveStripeSecretKey("not_a_stripe_key"), /Payment service is currently unavailable/);
    assert.throws(() => resolveStripeCurrency(""), /Payment service is currently unavailable/);
    assert.throws(() => resolveCheckoutClientUrl("http://prod.example.com", true), /Payment service is currently unavailable/);
    assert.equal(resolveCheckoutClientUrl("https://gearnest.app/", true), "https://gearnest.app");

    // 2. Account country unsupported currency check
    await assert.rejects(
      () =>
        verifyStripeAccountCurrencyEligibility(
          {
            accounts: { async retrieve() { return { country: "US", default_currency: "usd" }; } },
            countrySpecs: { async retrieve() { return { supported_payment_currencies: ["usd"] }; } },
          },
          "bdt",
          { bypassCache: true }
        ),
      (err) =>
        err.statusCode === 503 &&
        err.message === "The configured payment currency is not supported by the connected Stripe account"
    );

    // 3. Monetary minor-unit conversion across 2-decimal, 0-decimal, 3-decimal & invalid values
    assert.equal(convertToStripeMinorUnits(51000, "bdt"), 5100000);
    assert.equal(convertToStripeMinorUnits(125.5, "usd"), 12550);
    assert.equal(convertToStripeMinorUnits(1500, "jpy"), 1500);
    assert.equal(convertToStripeMinorUnits(12.345, "kwd"), 12345);

    for (const [amt, cur] of [
      [0, "bdt"],
      [-500, "bdt"],
      [NaN, "bdt"],
      [Infinity, "bdt"],
      [10.999, "usd"],
      [10.5, "jpy"],
      [2000000, "bdt"], // exceeds Stripe 8-digit unit_amount cap 99999999 minor units
    ]) {
      assert.throws(() => convertToStripeMinorUnits(amt, cur));
    }
  });

  test("AUTHORIZATION & RESERVATION VALIDATION: Roles, ownership, expiry & anti-tampering", async () => {
    const tokenA = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);
    const tokenOwner = await signUserJwt(ownerId, USER_ROLES.OWNER);
    const tokenAdmin = await signUserJwt(adminId, USER_ROLES.ADMIN);

    // Unauthenticated rejected -> 401
    let res = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingIntentId: validIntentId.toString() }),
    });
    assert.equal(res.status, 401);

    // Owner & Admin rejected -> 403 Customer access required
    for (const badToken of [tokenOwner, tokenAdmin]) {
      res = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${badToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bookingIntentId: validIntentId.toString() }),
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).message, "Customer access required");
    }

    // Another customer's bookingIntentId rejected -> 404 without exposing details
    res = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingIntentId: otherCustomerIntentId.toString() }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).message, "Booking reservation not found");

    // Malformed bookingIntentId & restricted frontend manipulation fields -> 400
    for (const badBody of [
      { bookingIntentId: "invalid-id" },
      { bookingIntentId: validIntentId.toString(), totalAmount: 1 },
      { bookingIntentId: validIntentId.toString(), currency: "usd" },
      { bookingIntentId: validIntentId.toString(), successUrl: "https://evil.example" },
      { bookingIntentId: validIntentId.toString(), cancelUrl: "https://evil.example" },
      { bookingIntentId: validIntentId.toString(), customerId: customerBId },
    ]) {
      res = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(badBody),
      });
      assert.equal(res.status, 400);
    }

    // Missing reservation -> 404
    res = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingIntentId: new ObjectId().toString() }),
    });
    assert.equal(res.status, 404);

    // Expired reservation -> 410 and marks status Expired
    res = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingIntentId: expiredIntentId.toString() }),
    });
    assert.equal(res.status, 410);
    assert.equal((await res.json()).message, "Booking reservation has expired");
    assert.equal(
      bookingIntentsDb.find((d) => String(d._id) === expiredIntentId.toString()).status,
      BOOKING_INTENT_STATUSES.EXPIRED
    );

    // Already converted reservation -> 409
    res = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingIntentId: convertedIntentId.toString() }),
    });
    assert.equal(res.status, 409);

    // Pending equipment associated with intent -> 409
    const pendingEqIntentId = new ObjectId();
    bookingIntentsDb.push({
      _id: pendingEqIntentId,
      customerId: customerAId,
      ownerId,
      equipmentId: equipmentPendingId,
      startDate: new Date("2026-11-24T00:00:00.000Z"),
      endDate: new Date("2026-11-26T00:00:00.000Z"),
      quantity: 1,
      rentalType: "Daily",
      rentalPrice: 4000,
      billableUnits: 3,
      totalAmount: 12000,
      currency: "BDT",
      status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
      expiresAt: new Date(fixedNow.getTime() + 600000),
    });
    res = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingIntentId: pendingEqIntentId.toString() }),
    });
    assert.equal(res.status, 409);

    // Account doesn't support configured currency -> 503 UNSUPPORTED_CURRENCY
    stripeMockState.currencySupported = false;
    res = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingIntentId: validIntentId.toString() }),
    });
    assert.equal(res.status, 503);
    assert.equal(
      (await res.json()).message,
      "The configured payment currency is not supported by the connected Stripe account"
    );
  });

  test("CHECKOUT CREATION, METADATA, EXPIRY SYNC, IDEMPOTENCY & CONCURRENCY", async () => {
    const tokenA = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);

    // 1. Concurrent requests do NOT create duplicate Stripe sessions
    stripeMockState.delayCreateMs = 20;
    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/api/payments/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bookingIntentId: validIntentId.toString() }),
      }),
      fetch(`${baseUrl}/api/payments/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bookingIntentId: validIntentId.toString() }),
      }),
    ]);
    stripeMockState.delayCreateMs = 0;

    // Only ONE Stripe checkout.sessions.create executed
    assert.equal(stripeMockState.createCalls.length, 1);
    const createdCall = stripeMockState.createCalls[0];
    assert.equal(createdCall.options.idempotencyKey, `gearnest_checkout_${validIntentId.toString()}_attempt_1`);
    assert.equal(createdCall.params.mode, "payment");
    assert.equal(createdCall.params.line_items[0].price_data.currency, "bdt");
    assert.equal(createdCall.params.line_items[0].price_data.unit_amount, 5100000);
    assert.equal(createdCall.params.line_items[0].price_data.product_data.name, "CAT Mini Excavator 302");
    assert.match(createdCall.params.line_items[0].price_data.product_data.description, /2 unit\(s\), Daily rental \(2026-11-24 to 2026-11-26\)/);
    assert.equal(createdCall.params.customer_email, "customer.a@gearnest.test");
    assert.equal(createdCall.params.client_reference_id, validIntentId.toString());
    assert.deepEqual(createdCall.params.metadata, {
      bookingIntentId: validIntentId.toString(),
      customerId: customerAId,
      ownerId,
      equipmentId: equipmentApprovedId.toString(),
    });
    assert.equal(
      createdCall.params.success_url,
      "http://localhost:3000/payment/success?session_id={CHECKOUT_SESSION_ID}"
    );
    assert.equal(
      createdCall.params.cancel_url,
      `http://localhost:3000/payment/cancel?bookingIntentId=${validIntentId.toString()}`
    );

    const winnerRes = [r1, r2].find((r) => r.status === 201);
    assert.ok(winnerRes);
    const winnerJson = await winnerRes.json();
    assert.equal(winnerJson.success, true);
    assert.equal(winnerJson.data.bookingIntentId, validIntentId.toString());
    assert.equal(winnerJson.data.currency, "bdt");
    assert.equal(winnerJson.data.totalAmount, 51000);
    assert.ok(winnerJson.data.checkoutUrl.startsWith("https://checkout.stripe.com/"));

    // Verify reservation expiresAt synchronized beyond 30-min checkout expiry (+2 min margin)
    const syncedIntent = bookingIntentsDb.find(
      (d) => String(d._id) === validIntentId.toString()
    );
    assert.equal(syncedIntent.status, BOOKING_INTENT_STATUSES.PENDING_PAYMENT);
    assert.equal(syncedIntent.checkoutAttempt, 1);
    assert.equal(syncedIntent.stripeCheckoutSessionId, winnerJson.data.sessionId);
    assert.equal(
      syncedIntent.expiresAt.getTime(),
      fixedNow.getTime() + 32 * 60 * 1000
    );

    // No final booking or Paid payment created in Commit 10
    assert.equal(finalizedBookingsDb.length, 0);
    assert.equal(paymentsDb.length, 0);

    // 2. Repeated request reuses existing open Checkout Session -> 200 & 0 new sessions created
    const reuseRes = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingIntentId: validIntentId.toString() }),
    });
    const reuseJson = await reuseRes.json();
    assert.equal(reuseRes.status, 200);
    assert.equal(reuseJson.data.sessionId, winnerJson.data.sessionId);
    assert.equal(stripeMockState.createCalls.length, 1);
    assert.ok(stripeMockState.retrieveCalls.includes(winnerJson.data.sessionId));

    // 3. Expired Stripe session while intent remains valid creates attempt 2 cleanly
    stripeMockState.sessionsById.get(winnerJson.data.sessionId).status = "expired";
    const renewRes = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingIntentId: validIntentId.toString() }),
    });
    assert.equal(renewRes.status, 201);
    const renewJson = await renewRes.json();
    assert.notEqual(renewJson.data.sessionId, winnerJson.data.sessionId);
    assert.equal(stripeMockState.createCalls[1].options.idempotencyKey, `gearnest_checkout_${validIntentId.toString()}_attempt_2`);

    // 4. Already completed Stripe session blocks new session creation -> 409
    stripeMockState.sessionsById.get(renewJson.data.sessionId).status = "complete";
    const completeRes = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingIntentId: validIntentId.toString() }),
    });
    assert.equal(completeRes.status, 409);
  });

  test("STRIPE FAILURE, TIMEOUT & COMPENSATING EXPIRATION AFTER DB WRITE FAILURE", async () => {
    const tokenA = await signUserJwt(customerAId, USER_ROLES.CUSTOMER);

    // 1. Timeout returns controlled 504 without leaking Stripe secrets & frees lock for retry
    const timeoutErr = new Error("Connection ETIMEDOUT with sk_test_51FAKE999");
    timeoutErr.code = "ETIMEDOUT";
    stripeMockState.failNextCreateWith = timeoutErr;

    let res = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingIntentId: validIntentId.toString() }),
    });
    let text = await res.text();
    assert.equal(res.status, 504);
    assert.equal(text.includes("sk_test_"), false);

    // 2. DB update failure after Stripe creation expires orphaned Checkout Session immediately
    stripeMockState.failNextDbUpdate = true;
    res = await fetch(`${baseUrl}/api/payments/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bookingIntentId: validIntentId.toString() }),
    });
    text = await res.text();
    assert.equal(res.status, 500);
    assert.equal(text.includes("checkout.stripe.com"), false);
    assert.equal(stripeMockState.expireCalls.length, 1);

    const orphanedSessionId = stripeMockState.expireCalls[0];
    assert.equal(
      stripeMockState.sessionsById.get(orphanedSessionId).status,
      "expired"
    );
  });
});
