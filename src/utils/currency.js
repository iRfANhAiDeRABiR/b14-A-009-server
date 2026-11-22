import { ApiError } from "./ApiError.js";

// https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

// Three-decimal ISO currencies supported by Stripe
const THREE_DECIMAL_CURRENCIES = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

// Conservative currency-aware minimum minor units aligned with Stripe charge minimums
const CURRENCY_MIN_MINOR_UNITS = Object.freeze({
  bdt: 100, // >= 1.00 BDT (100 paisa); Stripe presentment accounts require valid positive settlement minimum
  usd: 50,
  eur: 50,
  gbp: 30,
  jpy: 50,
  cad: 50,
  aud: 50,
  sgd: 50,
});

// Stripe Checkout unit_amount maximum minor units
const MAX_STRIPE_UNIT_AMOUNT = 99999999;

export function getCurrencyExponent(currency) {
  const normalized = String(currency || "").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(normalized)) {
    throw new ApiError("Unsupported payment currency configuration.", 503, {
      code: "STRIPE_CURRENCY_NOT_CONFIGURED",
    });
  }

  if (ZERO_DECIMAL_CURRENCIES.has(normalized)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(normalized)) return 3;
  return 2;
}

/**
 * Converts a major currency amount to integer minor units using the currency's official
 * Stripe exponent without floating-point rounding drift. Validates Stripe min/max charge bounds.
 */
export function convertToStripeMinorUnits(amount, currency) {
  const normalizedCurrency = String(currency || "").trim().toLowerCase();
  const exponent = getCurrencyExponent(normalizedCurrency);

  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new ApiError("Invalid payment amount.", 400, {
      code: "INVALID_PAYMENT_AMOUNT",
    });
  }

  const multiplier = 10 ** exponent;
  const scaled = Math.round((amount + Number.EPSILON) * multiplier);

  if (!Number.isSafeInteger(scaled) || scaled <= 0) {
    throw new ApiError("Invalid payment amount.", 400, {
      code: "INVALID_PAYMENT_AMOUNT",
    });
  }

  // Reject amounts carrying finer fractional precision than the currency supports (e.g. decimals in JPY)
  if (Math.abs(scaled / multiplier - amount) > 1e-9) {
    throw new ApiError("Payment amount precision does not match currency decimals.", 400, {
      code: "INVALID_PAYMENT_AMOUNT",
    });
  }

  const minMinorUnits = CURRENCY_MIN_MINOR_UNITS[normalizedCurrency] ?? 1;
  if (scaled < minMinorUnits) {
    throw new ApiError("Payment amount is below Stripe minimum charge limit.", 400, {
      code: "AMOUNT_TOO_SMALL",
    });
  }

  if (scaled > MAX_STRIPE_UNIT_AMOUNT) {
    throw new ApiError("Payment amount exceeds Stripe maximum charge limit.", 400, {
      code: "AMOUNT_TOO_LARGE",
    });
  }

  return scaled;
}
