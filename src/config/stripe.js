import Stripe from "stripe";
import { ApiError } from "../utils/ApiError.js";

const STRIPE_KEY_PATTERN = /^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}$/;
const ISO_CURRENCY_PATTERN = /^[a-z]{3}$/;

let cachedStripeKey = "";
let cachedStripeClient = null;
const verifiedCurrencyCache = new Map();

export function isValidStripeSecretKeyFormat(secretKey) {
  return typeof secretKey === "string" && STRIPE_KEY_PATTERN.test(secretKey.trim());
}

/**
 * Resolves and validates the server Stripe secret key without leaking credential values.
 */
export function resolveStripeSecretKey(secretOverride) {
  const rawKey =
    secretOverride !== undefined ? secretOverride : process.env.STRIPE_SECRET_KEY;
  const cleanKey = typeof rawKey === "string" ? rawKey.trim() : "";

  if (!cleanKey || !isValidStripeSecretKeyFormat(cleanKey)) {
    throw new ApiError("Payment service is currently unavailable", 503, {
      code: "STRIPE_NOT_CONFIGURED",
    });
  }

  return cleanKey;
}

/**
 * Validates explicitly configured STRIPE_CURRENCY (e.g., `bdt`) without inventing exchange rates.
 */
export function resolveStripeCurrency(currencyOverride) {
  const rawCurrency =
    currencyOverride !== undefined ? currencyOverride : process.env.STRIPE_CURRENCY;
  const cleanCurrency =
    typeof rawCurrency === "string" ? rawCurrency.trim().toLowerCase() : "";

  if (!cleanCurrency || !ISO_CURRENCY_PATTERN.test(cleanCurrency)) {
    throw new ApiError("Payment service is currently unavailable", 503, {
      code: "STRIPE_CURRENCY_NOT_CONFIGURED",
    });
  }

  return cleanCurrency;
}

/**
 * Validates redirect base URL strictly (HTTPS required in production).
 */
export function resolveCheckoutClientUrl(clientUrlOverride, isProductionOverride) {
  const isProd =
    isProductionOverride !== undefined
      ? isProductionOverride
      : String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  const rawUrl =
    clientUrlOverride !== undefined
      ? clientUrlOverride
      : process.env.CLIENT_URL || (!isProd ? "http://localhost:3000" : "");

  const cleaned = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!cleaned) {
    throw new ApiError("Payment service is currently unavailable", 503, {
      code: "CLIENT_URL_NOT_CONFIGURED",
    });
  }

  try {
    const parsed = new URL(cleaned);
    if (isProd && parsed.protocol !== "https:") {
      throw new ApiError("Payment service is currently unavailable", 503, {
        code: "INVALID_CLIENT_URL",
      });
    }
    if (!isProd && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ApiError("Payment service is currently unavailable", 503, {
        code: "INVALID_CLIENT_URL",
      });
    }
    return parsed.origin;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("Payment service is currently unavailable", 503, {
      code: "INVALID_CLIENT_URL",
    });
  }
}

/**
 * Returns the singleton Stripe SDK client initialized strictly with server credentials.
 */
export function getStripeClient({ secretKey } = {}) {
  const resolvedKey = resolveStripeSecretKey(secretKey);

  if (cachedStripeClient && cachedStripeKey === resolvedKey) {
    return cachedStripeClient;
  }

  cachedStripeClient = new Stripe(resolvedKey, {
    maxNetworkRetries: 2,
    timeout: 15000,
  });
  cachedStripeKey = resolvedKey;
  verifiedCurrencyCache.clear();

  return cachedStripeClient;
}

/**
 * Verifies against Stripe account & country specs whether the connected Stripe account supports
 * charging in the configured currency (never silently converting BDT -> USD).
 */
export async function verifyStripeAccountCurrencyEligibility(
  stripeClient,
  currency,
  { cacheKey = cachedStripeKey || "default", bypassCache = false } = {}
) {
  const normalizedCurrency = resolveStripeCurrency(currency);
  const entryKey = `${cacheKey}:${normalizedCurrency}`;

  if (!bypassCache && verifiedCurrencyCache.has(entryKey)) {
    return verifiedCurrencyCache.get(entryKey);
  }

  try {
    const account = await stripeClient.accounts.retrieve();
    if (!account || typeof account.country !== "string" || !account.country.trim()) {
      throw new ApiError("Payment service is currently unavailable", 503, {
        code: "STRIPE_ACCOUNT_UNAVAILABLE",
      });
    }

    const countrySpec = await stripeClient.countrySpecs.retrieve(account.country);
    const supported = Array.isArray(countrySpec?.supported_payment_currencies)
      ? countrySpec.supported_payment_currencies.map((c) => String(c).toLowerCase())
      : [];

    if (!supported.includes(normalizedCurrency)) {
      throw new ApiError(
        "The configured payment currency is not supported by the connected Stripe account",
        503,
        { code: "UNSUPPORTED_CURRENCY" }
      );
    }

    const meta = {
      country: account.country,
      defaultCurrency: String(account.default_currency || "").toLowerCase(),
      supportedCurrencies: supported,
    };
    verifiedCurrencyCache.set(entryKey, meta);
    return meta;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.statusCode === 401 || error?.type === "StripeAuthenticationError") {
      throw new ApiError("Payment service is currently unavailable", 503, {
        code: "STRIPE_NOT_CONFIGURED",
      });
    }
    throw new ApiError("Payment service is currently unavailable", 503, {
      code: "STRIPE_UNAVAILABLE",
    });
  }
}

export function clearStripeConfigurationCache() {
  cachedStripeKey = "";
  cachedStripeClient = null;
  verifiedCurrencyCache.clear();
}
