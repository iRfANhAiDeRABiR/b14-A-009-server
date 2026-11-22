const UTC_MONTH_ABBREVIATIONS = Object.freeze([
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]);

/**
 * Formats a UTC year/month pair into canonical `YYYY-MM` and readable `MMM YYYY` labels.
 */
export function formatUTCMonthSlot(year, monthIndex) {
  const normalizedDate = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const y = normalizedDate.getUTCFullYear();
  const m = normalizedDate.getUTCMonth();
  const yearMonth = `${y}-${String(m + 1).padStart(2, "0")}`;
  const label = `${UTC_MONTH_ABBREVIATIONS[m]} ${y}`;

  return {
    yearMonth,
    month: label,
    label,
  };
}

/**
 * Builds deterministic UTC calendar-month bounds and zero-filled ordered month slots
 * from oldest month in window up to the current UTC calendar month without day-overflow drift.
 */
export function getAnalyticsMonthWindow(monthsCount, referenceDate = new Date()) {
  const safeDate =
    referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
      ? referenceDate
      : new Date();

  const endYear = safeDate.getUTCFullYear();
  const endMonthIndex = safeDate.getUTCMonth();

  const currentMonthStart = new Date(Date.UTC(endYear, endMonthIndex, 1, 0, 0, 0, 0));
  const nextMonthStart = new Date(Date.UTC(endYear, endMonthIndex + 1, 1, 0, 0, 0, 0));
  const windowStart = new Date(
    Date.UTC(endYear, endMonthIndex - (monthsCount - 1), 1, 0, 0, 0, 0)
  );

  const months = [];
  for (let offset = monthsCount - 1; offset >= 0; offset -= 1) {
    months.push(formatUTCMonthSlot(endYear, endMonthIndex - offset));
  }

  return {
    windowStart,
    currentMonthStart,
    nextMonthStart,
    currentYearMonth: formatUTCMonthSlot(endYear, endMonthIndex).yearMonth,
    months,
  };
}

/**
 * Zero-fills a YYYY-MM lookup map across ordered UTC reporting month slots.
 */
export function zeroFillMonthlySeries(months, valueMap, mapEntryFn) {
  return months.map((slot) => {
    const rawValue = valueMap.get(slot.yearMonth);
    return mapEntryFn(slot, rawValue);
  });
}
