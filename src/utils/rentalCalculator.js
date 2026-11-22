import { RENTAL_TYPES } from "../constants/equipment.js";
import {
  DEFAULT_CURRENCY,
  fromMinorUnits,
  roundCurrency,
  toMinorUnits,
} from "../constants/payment.js";
import { ApiError } from "./ApiError.js";

/**
 * Calculates billable rental units aligned identically with the GearNest frontend pricing rule:
 * - Daily:   inclusiveDays
 * - Weekly:  ceil(inclusiveDays / 7)
 * - Monthly: ceil(inclusiveDays / 30)
 */
export function getBillableUnits(inclusiveDays, rentalType = "Daily") {
  if (!Number.isInteger(inclusiveDays) || inclusiveDays < 1) {
    throw new ApiError("Invalid rental date range", 400, {
      code: "INVALID_DATE_RANGE",
    });
  }

  if (!RENTAL_TYPES.includes(rentalType)) {
    throw new ApiError("Unsupported equipment rental type.", 400, {
      code: "INVALID_RENTAL_TYPE",
    });
  }

  if (rentalType === "Weekly") {
    return Math.ceil(inclusiveDays / 7);
  }
  if (rentalType === "Monthly") {
    return Math.ceil(inclusiveDays / 30);
  }
  return inclusiveDays;
}

/**
 * Computes authoritative rental pricing using integer minor-unit arithmetic (`toMinorUnits`)
 * so floating-point precision drift never affects BDT totals or Stripe calculations.
 */
export function calculateRentalTotals({
  rentalPrice,
  rentalType,
  inclusiveDays,
  quantity,
  currency = DEFAULT_CURRENCY,
}) {
  const numericPrice = Number(rentalPrice);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    throw new ApiError("Equipment rental price configuration is invalid.", 400, {
      code: "INVALID_EQUIPMENT_PRICE",
    });
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ApiError("Invalid rental quantity", 400, {
      code: "INVALID_QUANTITY",
    });
  }

  const normalizedPrice = roundCurrency(numericPrice);
  const unitMinor = toMinorUnits(normalizedPrice);
  const billableUnits = getBillableUnits(inclusiveDays, rentalType);

  const totalMinor = unitMinor * billableUnits * quantity;
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) {
    throw new ApiError("Calculated rental total exceeds safe numeric bounds.", 400, {
      code: "INVALID_TOTAL_AMOUNT",
    });
  }

  const totalAmount = fromMinorUnits(totalMinor);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new ApiError("Calculated rental total is invalid.", 400, {
      code: "INVALID_TOTAL_AMOUNT",
    });
  }

  return {
    rentalType,
    rentalPrice: normalizedPrice,
    billableUnits,
    quantity,
    totalAmount,
    currency,
  };
}
