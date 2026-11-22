import { BOOKING_INTENT_STATUSES } from "../constants/booking.js";
import { PAYMENT_STATUSES } from "../constants/payment.js";
import {
  getBookingIntentsCollection,
  getBookingsCollection,
  getEquipmentCollection,
  getPaymentsCollection,
} from "../models/collections.js";
import { ApiError } from "../utils/ApiError.js";
import { calculateInclusiveDays, formatUTCDateOnly } from "../utils/rentalDate.js";
import { validateCreateCheckoutSessionPayload } from "../validators/payment.validator.js";
import { normalizeUserIdentifier } from "../validators/validationHelpers.js";
import { validatePaymentSessionIdParam } from "../validators/webhook.validator.js";
import { stripeCheckoutService } from "./stripeCheckout.service.js";

/**
 * Payment domain service orchestrating Checkout Session initiation and read-only session status lookup.
 * Payment confirmation happens strictly inside verified webhook processing, never from GET status polling.
 */
export function createPaymentService({
  checkoutService = stripeCheckoutService,
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
  };
}

export const paymentService = createPaymentService();
