import { BOOKING_INTENT_STATUSES } from "../constants/booking.js";
import { EQUIPMENT_STATUSES } from "../constants/equipment.js";
import { env, redactMongoUri } from "../config/env.js";
import {
  getStripeClient,
  resolveCheckoutClientUrl,
  resolveStripeCurrency,
  verifyStripeAccountCurrencyEligibility,
} from "../config/stripe.js";
import {
  getBookingIntentsCollection,
  getEquipmentCollection,
  getUsersCollection,
} from "../models/collections.js";
import { buildUserLookupFilter } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { convertToStripeMinorUnits } from "../utils/currency.js";
import { formatUTCDateOnly, validateRentalDateRange } from "../utils/rentalDate.js";
import { normalizeUserIdentifier } from "../validators/validationHelpers.js";

const APPROVED_STRIPE_CHECKOUT_HOSTS = new Set([
  "checkout.stripe.com",
  "checkout.link.com",
]);

const CHECKOUT_SAFETY_BUFFER_MS = 2 * 60 * 1000;
const CHECKOUT_LOCK_LEASE_MS = 30 * 1000;

export function isApprovedStripeCheckoutUrl(rawUrl) {
  const clean = String(rawUrl || "").trim();
  if (!clean) return false;
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      APPROVED_STRIPE_CHECKOUT_HOSTS.has(host) ||
      host.endsWith(".checkout.stripe.com")
    );
  } catch {
    return false;
  }
}

function mapStripeApiError(error) {
  if (error instanceof ApiError) {
    return error;
  }

  const errorType = String(error?.type || "");
  const message = String(error?.message || "");
  const code = String(error?.code || "");

  if (errorType === "StripeAuthenticationError" || error?.statusCode === 401) {
    return new ApiError("Payment service is currently unavailable", 503, {
      code: "STRIPE_NOT_CONFIGURED",
    });
  }

  if (
    errorType === "StripeInvalidRequestError" &&
    /currency|supported|presentment/i.test(message)
  ) {
    return new ApiError(
      "The configured payment currency is not supported by the connected Stripe account",
      503,
      { code: "UNSUPPORTED_CURRENCY" }
    );
  }

  if (
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    code === "ESOCKETTIMEDOUT" ||
    errorType === "StripeConnectionError" ||
    /timeout|timed out/i.test(message)
  ) {
    return new ApiError(
      "Payment gateway timed out while preparing checkout. Please retry.",
      504,
      { code: "STRIPE_TIMEOUT" }
    );
  }

  if (errorType === "StripeInvalidRequestError") {
    return new ApiError(
      "Unable to initiate Stripe Checkout for this reservation",
      400,
      { code: "STRIPE_INVALID_REQUEST" }
    );
  }

  return new ApiError("Payment service is currently unavailable", 503, {
    code: "STRIPE_UNAVAILABLE",
  });
}

function buildCheckoutLineDescription({ equipmentName, intent }) {
  const startStr =
    intent.startDate instanceof Date
      ? formatUTCDateOnly(intent.startDate)
      : String(intent.startDate || "");
  const endStr =
    intent.endDate instanceof Date
      ? formatUTCDateOnly(intent.endDate)
      : String(intent.endDate || "");
  return `${equipmentName} — ${intent.quantity} unit(s), ${intent.rentalType} rental (${startStr} to ${endStr})`;
}

/**
 * Factory creating Stripe Hosted Checkout integration backed by temporary `bookingIntents`.
 * Guarantees server-authoritative pricing, idempotency keys, expiry synchronization,
 * and compensating session expiration on persistence failure.
 */
export function createStripeCheckoutService({
  bookingIntentsCollectionGetter = getBookingIntentsCollection,
  equipmentCollectionGetter = getEquipmentCollection,
  usersCollectionGetter = getUsersCollection,
  stripeClientGetter = getStripeClient,
  currencyResolver = () => resolveStripeCurrency(),
  clientUrlResolver = () => resolveCheckoutClientUrl(),
  currencyEligibilityVerifier = verifyStripeAccountCurrencyEligibility,
  checkoutExpireMinutesResolver = () => env.stripeCheckoutExpireMinutes,
  nowProvider = () => new Date(),
} = {}) {
  async function expireStripeSessionSafely(stripeClient, sessionId) {
    if (!sessionId) return;
    await stripeClient.checkout.sessions.expire(sessionId).catch(() => null);
  }

  return {
    async createCheckoutSession({ customerId, bookingIntentObjectId }) {
      const normalizedCustomerId = normalizeUserIdentifier(customerId, "customerId");
      const now = nowProvider();

      // 1. Validate Stripe config, currency, CLIENT_URL, and account eligibility
      const stripeClient = stripeClientGetter();
      const configuredCurrency = currencyResolver();
      const clientUrl = clientUrlResolver();
      await currencyEligibilityVerifier(stripeClient, configuredCurrency);

      const [
        bookingIntentsCollection,
        equipmentCollection,
        usersCollection,
      ] = await Promise.all([
        bookingIntentsCollectionGetter(),
        equipmentCollectionGetter(),
        usersCollectionGetter(),
      ]);

      // 2. Load & authorize booking intent strictly for the authenticated customer
      const intent = await bookingIntentsCollection.findOne({
        _id: bookingIntentObjectId,
      });

      if (!intent || String(intent.customerId) !== normalizedCustomerId) {
        throw new ApiError("Booking reservation not found", 404, {
          code: "RESERVATION_NOT_FOUND",
        });
      }

      if (intent.status === BOOKING_INTENT_STATUSES.CONVERTED) {
        throw new ApiError("This booking has already been processed", 409, {
          code: "ALREADY_COMPLETED",
        });
      }

      if (
        intent.status === BOOKING_INTENT_STATUSES.EXPIRED ||
        !(intent.expiresAt instanceof Date) ||
        intent.expiresAt.getTime() <= now.getTime()
      ) {
        if (intent.status === BOOKING_INTENT_STATUSES.PENDING_PAYMENT) {
          await bookingIntentsCollection.updateOne(
            {
              _id: intent._id,
              status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
            },
            {
              $set: {
                status: BOOKING_INTENT_STATUSES.EXPIRED,
                updatedAt: now,
              },
            }
          );
        }
        throw new ApiError("Booking reservation has expired", 410, {
          code: "RESERVATION_EXPIRED",
        });
      }

      if (intent.status !== BOOKING_INTENT_STATUSES.PENDING_PAYMENT) {
        throw new ApiError("This booking has already been processed", 409, {
          code: "ALREADY_COMPLETED",
        });
      }

      // 3. Revalidate rental dates & approved equipment eligibility
      const startStr = formatUTCDateOnly(intent.startDate);
      const endStr = formatUTCDateOnly(intent.endDate);
      validateRentalDateRange(startStr, endStr, { now });

      const equipment = await equipmentCollection.findOne({
        _id: intent.equipmentId,
      });
      if (!equipment || equipment.isDeleted === true) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }
      if (equipment.status !== EQUIPMENT_STATUSES.APPROVED) {
        throw new ApiError(
          "This equipment is not currently available for booking",
          409,
          { code: "EQUIPMENT_NOT_APPROVED" }
        );
      }

      // 4. Verify reservation currency matches configured Stripe currency & convert minor units
      const reservationCurrency = String(intent.currency || configuredCurrency)
        .trim()
        .toLowerCase();
      if (reservationCurrency !== configuredCurrency) {
        throw new ApiError(
          "The configured payment currency is not supported by the connected Stripe account",
          503,
          { code: "UNSUPPORTED_CURRENCY" }
        );
      }

      const unitAmountMinor = convertToStripeMinorUnits(
        Number(intent.totalAmount),
        configuredCurrency
      );

      // 5. Check existing Stripe Checkout Session for safe reuse or conflict detection
      const previousSessionId =
        typeof intent.stripeCheckoutSessionId === "string"
          ? intent.stripeCheckoutSessionId
          : null;

      if (previousSessionId) {
        let existingSession;
        try {
          existingSession = await stripeClient.checkout.sessions.retrieve(
            previousSessionId
          );
        } catch (error) {
          throw mapStripeApiError(error);
        }

        if (
          existingSession?.status === "complete" ||
          existingSession?.payment_status === "paid"
        ) {
          throw new ApiError("This booking has already been processed", 409, {
            code: "ALREADY_COMPLETED",
          });
        }

        const existingExpiresMs = Number(existingSession?.expires_at || 0) * 1000;
        if (
          existingSession?.status === "open" &&
          existingExpiresMs > now.getTime() &&
          isApprovedStripeCheckoutUrl(existingSession.url)
        ) {
          const syncedMinExpires = new Date(
            Math.max(
              intent.expiresAt.getTime(),
              existingExpiresMs + CHECKOUT_SAFETY_BUFFER_MS
            )
          );
          if (syncedMinExpires.getTime() > intent.expiresAt.getTime()) {
            await bookingIntentsCollection.updateOne(
              { _id: intent._id, status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT },
              { $set: { expiresAt: syncedMinExpires, updatedAt: now } }
            );
          }

          return {
            reused: true,
            data: {
              bookingIntentId: String(intent._id),
              sessionId: existingSession.id,
              checkoutUrl: existingSession.url,
              expiresAt: new Date(existingExpiresMs).toISOString(),
              currency: configuredCurrency,
              totalAmount: intent.totalAmount,
            },
          };
        }
      }

      // 6. Acquire atomic checkout lease lock to prevent concurrent duplicate Stripe calls
      const nextAttempt = (Number(intent.checkoutAttempt) || 0) + 1;
      const lockFilter = {
        _id: intent._id,
        customerId: normalizedCustomerId,
        status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
        expiresAt: { $gt: now },
        $and: [
          previousSessionId
            ? { stripeCheckoutSessionId: previousSessionId }
            : {
                $or: [
                  { stripeCheckoutSessionId: { $exists: false } },
                  { stripeCheckoutSessionId: null },
                ],
              },
          {
            $or: [
              { checkoutInProgressUntil: { $exists: false } },
              { checkoutInProgressUntil: null },
              { checkoutInProgressUntil: { $lte: now } },
            ],
          },
        ],
      };

      const lockResult = await bookingIntentsCollection.findOneAndUpdate(
        lockFilter,
        {
          $set: {
            checkoutAttempt: nextAttempt,
            checkoutInProgressUntil: new Date(
              now.getTime() + CHECKOUT_LOCK_LEASE_MS
            ),
            updatedAt: now,
          },
        },
        { returnDocument: "after" }
      );

      const lockedIntent =
        lockResult && typeof lockResult === "object" && "value" in lockResult
          ? lockResult.value
          : lockResult;

      if (!lockedIntent) {
        const refreshed = await bookingIntentsCollection.findOne({
          _id: intent._id,
        });
        if (
          refreshed?.stripeCheckoutSessionId &&
          refreshed.stripeCheckoutSessionId !== previousSessionId &&
          isApprovedStripeCheckoutUrl(refreshed.checkoutUrl) &&
          refreshed.checkoutExpiresAt instanceof Date &&
          refreshed.checkoutExpiresAt.getTime() > now.getTime()
        ) {
          return {
            reused: true,
            data: {
              bookingIntentId: String(refreshed._id),
              sessionId: refreshed.stripeCheckoutSessionId,
              checkoutUrl: refreshed.checkoutUrl,
              expiresAt: refreshed.checkoutExpiresAt.toISOString(),
              currency: configuredCurrency,
              totalAmount: refreshed.totalAmount,
            },
          };
        }

        throw new ApiError(
          "A payment checkout session is already being prepared for this reservation. Please retry momentarily.",
          409,
          { code: "CHECKOUT_IN_PROGRESS" }
        );
      }

      // 7. Load authenticated customer identity from MongoDB for prefilled customer_email
      const userDoc = await usersCollection.findOne(
        buildUserLookupFilter(normalizedCustomerId),
        { projection: { _id: 1, id: 1, name: 1, email: 1 } }
      );
      const customerEmail =
        typeof userDoc?.email === "string" && userDoc.email.trim()
          ? userDoc.email.trim()
          : undefined;

      // 8. Compute Stripe Checkout expiration (within 30m..24h) + sync hold safety margin
      const checkoutExpireMinutes = Math.max(
        30,
        Math.min(1440, Number(checkoutExpireMinutesResolver()) || 30)
      );
      const checkoutExpiresAt = new Date(
        now.getTime() + checkoutExpireMinutes * 60 * 1000
      );
      const stripeExpiresAtUnix = Math.floor(checkoutExpiresAt.getTime() / 1000);
      const syncedIntentExpiresAt = new Date(
        Math.max(
          intent.expiresAt.getTime(),
          checkoutExpiresAt.getTime() + CHECKOUT_SAFETY_BUFFER_MS
        )
      );

      const sessionParams = {
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: configuredCurrency,
              product_data: {
                name: equipment.name,
                description: buildCheckoutLineDescription({
                  equipmentName: equipment.name,
                  intent,
                }),
              },
              unit_amount: unitAmountMinor,
            },
            quantity: 1,
          },
        ],
        ...(customerEmail ? { customer_email: customerEmail } : {}),
        expires_at: stripeExpiresAtUnix,
        success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/payment/cancel?bookingIntentId=${String(intent._id)}`,
        client_reference_id: String(intent._id),
        metadata: {
          bookingIntentId: String(intent._id),
          customerId: String(intent.customerId),
          ownerId: String(intent.ownerId),
          equipmentId: String(intent.equipmentId),
        },
      };

      const idempotencyKey = `gearnest_checkout_${String(intent._id)}_attempt_${nextAttempt}`;

      let createdSession;
      try {
        createdSession = await stripeClient.checkout.sessions.create(
          sessionParams,
          { idempotencyKey }
        );
      } catch (error) {
        await bookingIntentsCollection
          .updateOne(
            { _id: intent._id },
            {
              $unset: { checkoutInProgressUntil: "" },
              $set: { updatedAt: new Date() },
            }
          )
          .catch(() => null);
        throw mapStripeApiError(error);
      }

      if (
        !createdSession?.id ||
        !isApprovedStripeCheckoutUrl(createdSession?.url)
      ) {
        await expireStripeSessionSafely(stripeClient, createdSession?.id);
        await bookingIntentsCollection
          .updateOne(
            { _id: intent._id },
            { $unset: { checkoutInProgressUntil: "" } }
          )
          .catch(() => null);
        throw new ApiError(
          "Payment provider returned an invalid checkout URL.",
          502,
          { code: "INVALID_CHECKOUT_URL" }
        );
      }

      // 9. Persist Stripe Checkout Session details & extend reservation hold safely
      try {
        const updateRes = await bookingIntentsCollection.updateOne(
          {
            _id: intent._id,
            status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
          },
          {
            $set: {
              stripeCheckoutSessionId: createdSession.id,
              checkoutUrl: createdSession.url,
              checkoutExpiresAt,
              checkoutCreatedAt: now,
              checkoutAttempt: nextAttempt,
              expiresAt: syncedIntentExpiresAt,
              updatedAt: now,
            },
            $unset: {
              checkoutInProgressUntil: "",
            },
          }
        );

        if (!updateRes || updateRes.modifiedCount === 0) {
          throw new Error("Booking intent could not be synchronized atomically.");
        }
      } catch (error) {
        await expireStripeSessionSafely(stripeClient, createdSession.id);
        const safeMsg = redactMongoUri(
          error?.message || "Failed to synchronize checkout reservation."
        );
        console.error(
          `[Payment Error] Checkout sync failed for reservation ${String(intent._id)}: ${safeMsg}`
        );
        throw new ApiError(
          "Unable to lock reservation through checkout expiration. Please retry booking.",
          500,
          { code: "CHECKOUT_SYNC_FAILED" }
        );
      }

      return {
        reused: false,
        data: {
          bookingIntentId: String(intent._id),
          sessionId: createdSession.id,
          checkoutUrl: createdSession.url,
          expiresAt: checkoutExpiresAt.toISOString(),
          currency: configuredCurrency,
          totalAmount: intent.totalAmount,
        },
      };
    },
  };
}

export const stripeCheckoutService = createStripeCheckoutService();
