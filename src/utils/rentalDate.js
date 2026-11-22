import { ApiError } from "../utils/ApiError.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ISO_CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a strict `YYYY-MM-DD` calendar string into midnight UTC without local timezone drift.
 * Returns null for malformed strings or nonexistent calendar dates (e.g., Feb 29 on non-leap years).
 */
export function parseCalendarDateUTC(rawDate) {
  if (typeof rawDate !== "string") return null;
  const trimmed = rawDate.trim();
  const match = ISO_CALENDAR_DATE_PATTERN.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const utcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const date = new Date(utcMs);

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

/**
 * Formats a Date (UTC calendar date) consistently into `YYYY-MM-DD`.
 */
export function formatUTCDateOnly(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "";
  }
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Computes inclusive calendar days between two normalized UTC dates.
 * Both startDate and endDate count toward the rental period (e.g., Nov 24..Nov 26 = 3 days).
 */
export function calculateInclusiveDays(startDate, endDate) {
  if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
    return 0;
  }
  const diffMs = endDate.getTime() - startDate.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 0;
  }
  return Math.floor(diffMs / MS_PER_DAY) + 1;
}

/**
 * Validates startDate and endDate strings (`YYYY-MM-DD`) in UTC, rejecting past start dates,
 * reversed ranges, invalid calendar dates, and malformed formats.
 */
export function validateRentalDateRange(
  rawStartDate,
  rawEndDate,
  { now = new Date() } = {}
) {
  const startDate = parseCalendarDateUTC(rawStartDate);
  const endDate = parseCalendarDateUTC(rawEndDate);

  if (!startDate || !endDate) {
    throw new ApiError("Invalid rental date range", 400, {
      code: "INVALID_DATE_RANGE",
    });
  }

  const reference = now instanceof Date ? now : new Date(now);
  const todayUtc = new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );

  if (startDate.getTime() < todayUtc.getTime()) {
    throw new ApiError("Invalid rental date range", 400, {
      code: "INVALID_DATE_RANGE",
    });
  }

  if (endDate.getTime() < startDate.getTime()) {
    throw new ApiError("Invalid rental date range", 400, {
      code: "INVALID_DATE_RANGE",
    });
  }

  const inclusiveDays = calculateInclusiveDays(startDate, endDate);
  if (inclusiveDays < 1) {
    throw new ApiError("Invalid rental date range", 400, {
      code: "INVALID_DATE_RANGE",
    });
  }

  return {
    startDate,
    endDate,
    startDateString: formatUTCDateOnly(startDate),
    endDateString: formatUTCDateOnly(endDate),
    inclusiveDays,
  };
}

/**
 * Computes reservation expiration Date from configured hold duration (default 10 minutes).
 */
export function calculateReservationExpiration({
  now = new Date(),
  holdMinutes = 10,
} = {}) {
  const baseMs = (now instanceof Date ? now : new Date(now)).getTime();
  return new Date(baseMs + holdMinutes * 60 * 1000);
}
