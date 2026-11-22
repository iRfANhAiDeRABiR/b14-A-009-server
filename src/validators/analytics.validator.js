import { ApiError } from "../utils/ApiError.js";

export const ALLOWED_ANALYTICS_PERIODS = Object.freeze(["3m", "6m", "12m"]);
export const DEFAULT_ANALYTICS_PERIOD = "12m";

export const PERIOD_MONTH_COUNTS = Object.freeze({
  "3m": 3,
  "6m": 6,
  "12m": 12,
});

function assertValidAnalyticsQueryObject(rawQuery) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    return;
  }

  for (const [key, value] of Object.entries(rawQuery)) {
    if (key.startsWith("$") || /\[\s*\$/.test(key)) {
      throw new ApiError("Invalid reporting period", 400, {
        code: "INVALID_REPORTING_PERIOD",
      });
    }
    if (value !== null && typeof value === "object") {
      throw new ApiError("Invalid reporting period", 400, {
        code: "INVALID_REPORTING_PERIOD",
      });
    }
  }
}

/**
 * Validates analytics reporting period query parameter (`3m`, `6m`, or `12m`).
 * Defaults to `12m` when omitted and rejects malformed or unsupported values cleanly.
 */
export function validateAnalyticsQuery(rawQuery = {}) {
  assertValidAnalyticsQueryObject(rawQuery);

  const rawPeriod = rawQuery?.period;
  if (rawPeriod === undefined || rawPeriod === null || String(rawPeriod).trim() === "") {
    return {
      period: DEFAULT_ANALYTICS_PERIOD,
      monthsCount: PERIOD_MONTH_COUNTS[DEFAULT_ANALYTICS_PERIOD],
    };
  }

  if (typeof rawPeriod !== "string") {
    throw new ApiError("Invalid reporting period", 400, {
      code: "INVALID_REPORTING_PERIOD",
    });
  }

  const normalizedPeriod = rawPeriod.trim().toLowerCase();
  if (!ALLOWED_ANALYTICS_PERIODS.includes(normalizedPeriod)) {
    throw new ApiError("Invalid reporting period", 400, {
      code: "INVALID_REPORTING_PERIOD",
    });
  }

  return {
    period: normalizedPeriod,
    monthsCount: PERIOD_MONTH_COUNTS[normalizedPeriod],
  };
}
