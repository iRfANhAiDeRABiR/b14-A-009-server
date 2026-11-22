import { BOOKING_INTENT_STATUSES } from "../constants/booking.js";
import { PAYMENT_STATUSES } from "../constants/payment.js";
import {
  getStripeClient,
  resolveStripeCurrency,
} from "../config/stripe.js";
import {
  getBookingIntentsCollection,
  getBookingsCollection,
  getEquipmentCollection,
  getPaymentsCollection,
} from "../models/collections.js";
import { ApiError } from "../utils/ApiError.js";
import { convertToStripeMinorUnits } from "../utils/currency.js";
import { calculateInclusiveDays, formatUTCDateOnly } from "../utils/rentalDate.js";
import { validateCreateCheckoutSessionPayload } from "../validators/payment.validator.js";
import {
  isValidObjectId,
  normalizeUserIdentifier,
  toObjectId,
} from "../validators/validationHelpers.js";
import { validatePaymentSessionIdParam } from "../validators/webhook.validator.js";
import { bookingFinalizationService } from "./bookingFinalization.service.js";
import { stripeCheckoutService } from "./stripeCheckout.service.js";

function extractPaymentIntentId(session) {
  if (!session?.payment_intent) return "";
  if (typeof session.payment_intent === "string") {
    return session.payment_intent.trim();
  }
  if (typeof session.payment_intent === "object" && session.payment_intent.id) {
    return String(session.payment_intent.id).trim();
  }
  return "";
}

/**
 * Payment domain service orchestrating Checkout Session initiation and read-only session status lookup.
 * Confirmation occurs strictly via verified Stripe webhook processing or direct server-to-Stripe verification.
 */
export function createPaymentService({
  checkoutService = stripeCheckoutService,
  stripeClientGetter = getStripeClient,
  currencyResolver = () => resolveStripeCurrency(),
  finalizationService = bookingFinalizationService,
  paymentsCollectionGetter = getPaymentsCollection,
  bookingsCollectionGetter = getBookingsCollection,
  bookingIntentsCollectionGetter = getBookingIntentsCollection,
  equipmentCollectionGetter = getEquipmentCollection,
  nowProvider = () => new Date(),
} = {}) {
  return {
    async createCheckoutSession({ customerId, payload }) {
      const { bookingIntentId } = validateCreateCheckoutSessionPayload(payload);
      return checkoutService.createCheckoutSession({
        customerId,
        bookingIntentObjectId: bookingIntentId,
      });
    },

    async getPaymentSessionStatus({ customerId, sessionId }) {
      const normalizedCustomerId = normalizeUserIdentifier(customerId, "customerId");
      const cleanSessionId = validatePaymentSessionIdParam(sessionId);
      const now = nowProvider();

      const [
        paymentsCollection,
        bookingsCollection,
        bookingIntentsCollection,
        equipmentCollection,
      ] = await Promise.all([
        paymentsCollectionGetter(),
        bookingsCollectionGetter(),
        bookingIntentsCollectionGetter(),
        equipmentCollectionGetter(),
      ]);

      const buildConfirmedResponse = async (payment, booking) => {
        const eq = await equipmentCollection.findOne(
          { _id: payment.equipmentId },
          { projection: { _id: 1, name: 1, image: 1, category: 1, rentalType: 1 } }
        );
        const startDate = booking?.startDate ? formatUTCDateOnly(booking.startDate) : "";
        const endDate = booking?.endDate ? formatUTCDateOnly(booking.endDate) : "";

        return {
          sessionId: cleanSessionId,
          bookingId: String(payment.bookingId),
          bookingReference: String(payment.bookingId),
          equipmentId: String(payment.equipmentId),
          equipmentName: eq?.name || "",
          equipmentImage: eq?.image || "",
          startDate,
          endDate,
          durationDays:
            booking?.startDate && booking?.endDate
              ? calculateInclusiveDays(booking.startDate, booking.endDate)
              : null,
          quantity: booking?.quantity ?? null,
          rentalType: booking?.rentalType || eq?.rentalType || "",
          totalAmount: payment.amount,
          currency: String(payment.currency || "").toLowerCase(),
          paymentStatus: payment.status,
          bookingStatus: booking?.bookingStatus || "Confirmed",
          transactionId: payment.stripePaymentIntentId || "",
          paidAt: payment.paidAt || payment.createdAt || null,
          verified: payment.status === PAYMENT_STATUSES.PAID,
        };
      };

      const payment = await paymentsCollection.findOne({
        stripeCheckoutSessionId: cleanSessionId,
        customerId: normalizedCustomerId,
      });

      if (payment) {
        const booking = await bookingsCollection.findOne({
          _id: payment.bookingId,
          customerId: normalizedCustomerId,
        });
        return buildConfirmedResponse(payment, booking);
      }

      const intent = await bookingIntentsCollection.findOne({
        stripeCheckoutSessionId: cleanSessionId,
        customerId: normalizedCustomerId,
      });

      if (!intent) {
        throw new ApiError("Payment session not found", 404, {
          code: "PAYMENT_SESSION_NOT_FOUND",
        });
      }

      if (intent.status === BOOKING_INTENT_STATUSES.CONVERTED && intent.finalBookingId) {
        const [booking, linkedPayment] = await Promise.all([
          bookingsCollection.findOne({
            _id: intent.finalBookingId,
            customerId: normalizedCustomerId,
          }),
          paymentsCollection.findOne({
            bookingId: intent.finalBookingId,
            customerId: normalizedCustomerId,
          }),
        ]);
        if (linkedPayment) {
          return buildConfirmedResponse(linkedPayment, booking);
        }
      }

      const eq = await equipmentCollection.findOne(
        { _id: intent.equipmentId },
        { projection: { _id: 1, name: 1, image: 1, rentalType: 1 } }
      );

      let paymentStatus = PAYMENT_STATUSES.PENDING;
      let bookingStatus = intent.status;
      let sessionStatus = "open";

      if (intent.status === BOOKING_INTENT_STATUSES.FAILED) {
        paymentStatus = PAYMENT_STATUSES.FAILED;
        bookingStatus = BOOKING_INTENT_STATUSES.FAILED;
        sessionStatus = "expired";
      } else if (
        intent.status === BOOKING_INTENT_STATUSES.EXPIRED ||
        !(intent.expiresAt instanceof Date) ||
        intent.expiresAt.getTime() <= now.getTime()
      ) {
        paymentStatus = PAYMENT_STATUSES.FAILED;
        bookingStatus = BOOKING_INTENT_STATUSES.EXPIRED;
        sessionStatus = "expired";
      }

      return {
        sessionId: cleanSessionId,
        bookingIntentId: String(intent._id),
        equipmentId: String(intent.equipmentId),
        equipmentName: eq?.name || "",
        equipmentImage: eq?.image || "",
        startDate: intent.startDate ? formatUTCDateOnly(intent.startDate) : "",
        endDate: intent.endDate ? formatUTCDateOnly(intent.endDate) : "",
        quantity: intent.quantity ?? null,
        rentalType: intent.rentalType || eq?.rentalType || "",
        totalAmount: intent.totalAmount,
        currency: String(intent.currency || "").toLowerCase(),
        paymentStatus,
        bookingStatus,
        sessionStatus,
        verified: false,
      };
    },

    /**
     * Authoritatively queries Stripe's API for a customer's Checkout Session and PaymentIntent.
     * Finalizes the reservation atomically ONLY when Stripe confirms `payment_status === "paid"`
     * and the PaymentIntent status is `"succeeded"`, acting as a safe reconciliation fallback
     * when webhook delivery is delayed or unconfigured.
     */
    async verifyAndSyncCheckoutSession({ customerId, sessionId }) {
      const normalizedCustomerId = normalizeUserIdentifier(customerId, "customerId");
      const cleanSessionId = validatePaymentSessionIdParam(sessionId);

      const [paymentsCollection, bookingIntentsCollection] = await Promise.all([
        paymentsCollectionGetter(),
        bookingIntentsCollectionGetter(),
      ]);

      const existingPayment = await paymentsCollection.findOne({
        stripeCheckoutSessionId: cleanSessionId,
        customerId: normalizedCustomerId,
      });
      if (existingPayment) {
        return this.getPaymentSessionStatus({ customerId, sessionId: cleanSessionId });
      }

      const intent = await bookingIntentsCollection.findOne({
        stripeCheckoutSessionId: cleanSessionId,
        customerId: normalizedCustomerId,
      });

      if (!intent) {
        throw new ApiError("Payment session not found", 404, {
          code: "PAYMENT_SESSION_NOT_FOUND",
        });
      }

      if (intent.status === BOOKING_INTENT_STATUSES.CONVERTED && intent.finalBookingId) {
        return this.getPaymentSessionStatus({ customerId, sessionId: cleanSessionId });
      }

      const stripeClient = stripeClientGetter();
      const configuredCurrency = currencyResolver();

      let session;
      try {
        session = await stripeClient.checkout.sessions.retrieve(cleanSessionId);
      } catch {
        throw new ApiError("Unable to verify Checkout Session with Stripe right now.", 502, {
          code: "STRIPE_SESSION_RETRIEVE_FAILED",
        });
      }

      if (
        !session ||
        session.id !== cleanSessionId ||
        session.mode !== "payment" ||
        session.status !== "complete" ||
        session.payment_status !== "paid"
      ) {
        return this.getPaymentSessionStatus({ customerId, sessionId: cleanSessionId });
      }

      const bookingIntentIdStr = String(session.metadata?.bookingIntentId || "").trim();
      const clientReferenceIdStr = String(session.client_reference_id || "").trim();
      if (
        !isValidObjectId(bookingIntentIdStr) ||
        bookingIntentIdStr !== String(intent._id) ||
        (clientReferenceIdStr && clientReferenceIdStr !== String(intent._id))
      ) {
        throw new ApiError("Stripe session metadata mismatch.", 409, {
          code: "PAYMENT_VERIFICATION_MISMATCH",
        });
      }

      const sessionCurrency = String(session.currency || "").trim().toLowerCase();
      const expectedMinorUnits = convertToStripeMinorUnits(
        Number(intent.totalAmount),
        configuredCurrency
      );

      if (
        sessionCurrency !== configuredCurrency ||
        Number(session.amount_total) !== expectedMinorUnits
      ) {
        throw new ApiError("Paid amount or currency mismatch.", 409, {
          code: "PAYMENT_AMOUNT_MISMATCH",
        });
      }

      const paymentIntentId = extractPaymentIntentId(session);
      let paidAt = nowProvider();
      if (paymentIntentId) {
        let paymentIntent;
        try {
          paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntentId);
        } catch {
          throw new ApiError("Unable to verify Stripe PaymentIntent right now.", 502, {
            code: "STRIPE_PAYMENT_INTENT_RETRIEVE_FAILED",
          });
        }

        const piCurrency = String(paymentIntent?.currency || "").trim().toLowerCase();
        const piReceived = Number(
          paymentIntent?.amount_received ?? paymentIntent?.amount
        );
        if (
          !paymentIntent ||
          paymentIntent.id !== paymentIntentId ||
          paymentIntent.status !== "succeeded" ||
          piCurrency !== configuredCurrency ||
          piReceived !== expectedMinorUnits
        ) {
          return this.getPaymentSessionStatus({ customerId, sessionId: cleanSessionId });
        }

        if (typeof paymentIntent.created === "number") {
          paidAt = new Date(paymentIntent.created * 1000);
        }
      }

      await finalizationService.finalizePaidCheckoutSession({
        eventId: `sync_${session.id}`,
        eventType: "checkout.session.verified_sync",
        bookingIntentId: toObjectId(bookingIntentIdStr, "bookingIntentId"),
        stripeSessionId: session.id,
        stripePaymentIntentId: paymentIntentId,
        amountMinor: expectedMinorUnits,
        currency: configuredCurrency,
        paidAt,
      });

      return this.getPaymentSessionStatus({ customerId, sessionId: cleanSessionId });
    },
  };
}

export const paymentService = createPaymentService();
