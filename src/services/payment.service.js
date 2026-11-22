import { validateCreateCheckoutSessionPayload } from "../validators/payment.validator.js";
import { stripeCheckoutService } from "./stripeCheckout.service.js";

/**
 * Payment domain service delegating Hosted Checkout creation to StripeCheckoutService.
 * Final bookings and Paid payment statuses are strictly deferred to Commit 11 webhook verification.
 */
export function createPaymentService({
  checkoutService = stripeCheckoutService,
} = {}) {
  return {
    async createCheckoutSession({ customerId, payload }) {
      const { bookingIntentId } = validateCreateCheckoutSessionPayload(payload);
      return checkoutService.createCheckoutSession({
        customerId,
        bookingIntentObjectId: bookingIntentId,
      });
    },
  };
}

export const paymentService = createPaymentService();
