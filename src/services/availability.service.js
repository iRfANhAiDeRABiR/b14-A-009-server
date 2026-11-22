import { BOOKING_INTENT_STATUSES, BOOKING_STATUSES } from "../constants/booking.js";
import { PAYMENT_STATUSES } from "../constants/payment.js";

/**
 * Calculates total reserved quantity across overlapping finalized bookings and
 * unexpired temporary booking intents directly inside MongoDB aggregation.
 *
 * Overlap condition (inclusive calendar days):
 *   existing.startDate <= requested.endDate AND existing.endDate >= requested.startDate
 */
export async function calculateOverlappingReservedQuantity({
  equipment,
  startDate,
  endDate,
  bookingsCollection,
  bookingIntentsCollection,
  now = new Date(),
  session = null,
}) {
  const aggOptions = session ? { session } : undefined;
  const equipmentObjectId = equipment._id;

  const bookingOverlapPipeline = [
    {
      $match: {
        equipmentId: equipmentObjectId,
        bookingStatus: { $ne: BOOKING_STATUSES.CANCELLED },
        paymentStatus: {
          $nin: [PAYMENT_STATUSES.FAILED, PAYMENT_STATUSES.REFUNDED],
        },
        startDate: { $lte: endDate },
        endDate: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: null,
        reservedQuantity: { $sum: "$quantity" },
      },
    },
  ];

  const intentOverlapPipeline = [
    {
      $match: {
        equipmentId: equipmentObjectId,
        status: BOOKING_INTENT_STATUSES.PENDING_PAYMENT,
        // Never depend solely on asynchronous TTL deletion
        expiresAt: { $gt: now },
        startDate: { $lte: endDate },
        endDate: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: null,
        reservedQuantity: { $sum: "$quantity" },
      },
    },
  ];

  const [finalizedAgg, intentAgg] = await Promise.all([
    bookingsCollection.aggregate(bookingOverlapPipeline, aggOptions).toArray(),
    bookingIntentsCollection.aggregate(intentOverlapPipeline, aggOptions).toArray(),
  ]);

  const finalizedReserved = Number(finalizedAgg[0]?.reservedQuantity) || 0;
  const intentReserved = Number(intentAgg[0]?.reservedQuantity) || 0;
  const totalQuantity = Math.max(0, Number(equipment.availableQuantity) || 0);
  const reservedQuantity = finalizedReserved + intentReserved;
  const remainingQuantity = Math.max(0, totalQuantity - reservedQuantity);

  return {
    totalQuantity,
    finalizedReserved,
    intentReserved,
    reservedQuantity,
    remainingQuantity,
  };
}
