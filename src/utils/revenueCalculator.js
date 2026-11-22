import { PAYMENT_STATUSES, roundCurrency } from "../constants/payment.js";

/**
 * Computes net collected major-currency amount from an authoritative payment record,
 * returning 0 for non-Paid rows and deducting any partial refund amount cleanly.
 */
export function calculateNetPaymentAmount(payment) {
  if (!payment || payment.status !== PAYMENT_STATUSES.PAID) {
    return 0;
  }

  const grossAmount =
    typeof payment.amount === "number" && Number.isFinite(payment.amount) && payment.amount > 0
      ? payment.amount
      : 0;
  const refundedAmount =
    typeof payment.refundedAmount === "number" &&
    Number.isFinite(payment.refundedAmount) &&
    payment.refundedAmount > 0
      ? payment.refundedAmount
      : 0;

  return roundCurrency(Math.max(0, grossAmount - refundedAmount));
}

/**
 * Builds the MongoDB aggregation pipeline stages that isolate paid transactions,
 * deduplicate by booking/payment reference, and compute currency-safe net major amounts
 * without mixing `amount` with `amountMinor`.
 */
export function buildAuthoritativePaidPaymentStages(earlyMatch = {}) {
  return [
    {
      $match: {
        ...earlyMatch,
        status: PAYMENT_STATUSES.PAID,
      },
    },
    {
      $sort: {
        paidAt: 1,
        createdAt: 1,
        _id: 1,
      },
    },
    {
      $group: {
        _id: {
          $ifNull: [
            "$bookingId",
            {
              $ifNull: [
                "$stripePaymentIntentId",
                { $ifNull: ["$stripeCheckoutSessionId", "$_id"] },
              ],
            },
          ],
        },
        amount: { $first: "$amount" },
        refundedAmount: { $first: "$refundedAmount" },
        paidAt: { $first: "$paidAt" },
        createdAt: { $first: "$createdAt" },
        ownerId: { $first: "$ownerId" },
        equipmentId: { $first: "$equipmentId" },
      },
    },
    {
      $project: {
        _id: 1,
        ownerId: 1,
        equipmentId: 1,
        effectivePaidAt: { $ifNull: ["$paidAt", "$createdAt"] },
        netAmount: {
          $max: [
            0,
            {
              $subtract: [
                {
                  $cond: [
                    { $isNumber: "$amount" },
                    "$amount",
                    0,
                  ],
                },
                {
                  $cond: [
                    {
                      $and: [
                        { $isNumber: "$refundedAmount" },
                        { $gt: ["$refundedAmount", 0] },
                      ],
                    },
                    "$refundedAmount",
                    0,
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  ];
}
