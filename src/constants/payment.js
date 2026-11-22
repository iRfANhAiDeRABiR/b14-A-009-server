export const PAYMENT_STATUSES = Object.freeze({
  PENDING: "Pending",
  PAID: "Paid",
  FAILED: "Failed",
  REFUNDED: "Refunded",
});

export const ALLOWED_PAYMENT_STATUSES = Object.freeze(
  Object.values(PAYMENT_STATUSES)
);

export const DEFAULT_PAYMENT_STATUS = PAYMENT_STATUSES.PENDING;

export const PAYMENT_PROVIDERS = Object.freeze({
  STRIPE: "stripe",
});

export const DEFAULT_CURRENCY = "BDT";

/**
 * Rounds a major currency decimal value cleanly to 2 fractional digits,
 * avoiding floating-point precision drift before persistence.
 */
export function roundCurrency(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) {
    throw new Error("Currency amount must be a finite number.");
  }
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

/**
 * Converts major currency units (e.g., 1250.50 BDT) into exact integer minor units
 * (e.g., 125050 paisa/cents) required by Stripe PaymentIntent and Checkout APIs.
 */
export function toMinorUnits(majorAmount) {
  const rounded = roundCurrency(majorAmount);
  return Math.round(rounded * 100);
}

/**
 * Converts integer minor units returned by Stripe back to major currency amounts.
 */
export function fromMinorUnits(minorAmount) {
  const numeric = Number(minorAmount);
  if (!Number.isFinite(numeric)) {
    throw new Error("Minor unit amount must be a finite number.");
  }
  return Math.round(numeric) / 100;
}
