import { DEFAULT_CURRENCY } from "../constants/payment.js";
import { calculateRentalTotals } from "../utils/rentalCalculator.js";

/**
 * Computes authoritative rental pricing from persisted MongoDB equipment pricing fields,
 * completely ignoring any client-supplied rate, billable units, or total amount.
 */
export function calculateAuthoritativeRentalPricing({
  equipment,
  inclusiveDays,
  quantity,
}) {
  return calculateRentalTotals({
    rentalPrice: equipment?.rentalPrice,
    rentalType: equipment?.rentalType,
    inclusiveDays,
    quantity,
    currency: DEFAULT_CURRENCY,
  });
}
