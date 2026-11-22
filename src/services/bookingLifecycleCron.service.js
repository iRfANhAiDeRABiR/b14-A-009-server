import cron from "node-cron";
import { BOOKING_STATUSES } from "../constants/booking.js";
import { PAYMENT_STATUSES } from "../constants/payment.js";
import { env, redactMongoUri } from "../config/env.js";
import { getBookingsCollection } from "../models/collections.js";
import { emailNotificationService as defaultEmailNotificationService } from "./emailNotification.service.js";

/**
 * Returns midnight UTC for the reference Date's calendar day (`YYYY-MM-DDT00:00:00.000Z`).
 */
export function getTodayUtcMidnight(referenceDate = new Date()) {
  const safe =
    referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
      ? referenceDate
      : new Date();
  return new Date(
    Date.UTC(safe.getUTCFullYear(), safe.getUTCMonth(), safe.getUTCDate(), 0, 0, 0, 0)
  );
}

/**
 * Factory creating the idempotent UTC cron scheduler that marks paid finalized rentals
 * `Completed` once their inclusive UTC `endDate` has passed and notifies Customer + Owner.
 */
export function createBookingLifecycleCronService({
  cronLib = cron,
  bookingsCollectionGetter = getBookingsCollection,
  emailNotificationService = defaultEmailNotificationService,
  nowProvider = () => new Date(),
  cronExpression = env.bookingCompletionCron,
  enabled = env.enableBookingCron,
} = {}) {
  let scheduledTask = null;
  let isSweepRunning = false;

  async function runCompletedBookingSweep() {
    if (isSweepRunning) {
      return { skipped: true, updatedCount: 0, completedIds: [] };
    }

    isSweepRunning = true;
    const completedIds = [];
    const notificationResults = [];

    try {
      const now = nowProvider();
      const todayUtcStart = getTodayUtcMidnight(now);
      const bookingsCollection = await bookingsCollectionGetter();

      const eligibleFilter = {
        bookingStatus: {
          $in: [BOOKING_STATUSES.CONFIRMED, BOOKING_STATUSES.ACTIVE],
        },
        paymentStatus: PAYMENT_STATUSES.PAID,
        endDate: { $lt: todayUtcStart },
      };

      const candidates = await bookingsCollection
        .find(eligibleFilter, {
          projection: {
            _id: 1,
            bookingStatus: 1,
            paymentStatus: 1,
            endDate: 1,
          },
        })
        .toArray();

      for (const candidate of candidates) {
        const updateResult = await bookingsCollection.findOneAndUpdate(
          {
            _id: candidate._id,
            bookingStatus: {
              $in: [BOOKING_STATUSES.CONFIRMED, BOOKING_STATUSES.ACTIVE],
            },
            paymentStatus: PAYMENT_STATUSES.PAID,
            endDate: { $lt: todayUtcStart },
          },
          {
            $set: {
              bookingStatus: BOOKING_STATUSES.COMPLETED,
              completedAt: now,
              updatedAt: now,
            },
          },
          { returnDocument: "after" }
        );

        const completedBooking =
          updateResult && typeof updateResult === "object" && "value" in updateResult
            ? updateResult.value
            : updateResult;

        if (!completedBooking) {
          // Another pod/instance already transitioned this booking atomically.
          continue;
        }

        const idStr = String(completedBooking._id);
        completedIds.push(idStr);
        console.log(
          `[GearNest Cron] Booking ${idStr} automatically marked Completed after UTC endDate.`
        );

        try {
          const notifyResult = await emailNotificationService.notifyBookingCompleted({
            booking: completedBooking,
          });
          notificationResults.push({ bookingId: idStr, ...notifyResult });
        } catch (notifyErr) {
          notificationResults.push({
            bookingId: idStr,
            notified: false,
            status: "failed",
            error: redactMongoUri(notifyErr?.message || "Notification error"),
          });
        }
      }

      return {
        skipped: false,
        updatedCount: completedIds.length,
        completedIds,
        notificationResults,
      };
    } finally {
      isSweepRunning = false;
    }
  }

  return {
    runCompletedBookingSweep,

    start() {
      if (!enabled || env.isTest) {
        return null;
      }

      if (scheduledTask) {
        return scheduledTask;
      }

      if (!cronLib.validate(cronExpression)) {
        console.warn(
          `[GearNest Cron] Invalid BOOKING_COMPLETION_CRON "${cronExpression}". Automated completion scheduler disabled.`
        );
        return null;
      }

      scheduledTask = cronLib.schedule(
        cronExpression,
        () => {
          runCompletedBookingSweep().catch((error) => {
            console.error(
              "[GearNest Cron] Booking completion sweep failed:",
              redactMongoUri(error?.message || String(error))
            );
          });
        },
        { timezone: "UTC" }
      );

      scheduledTask?.unref?.();
      console.log(
        `[GearNest Cron] Automated booking completion job scheduled (${cronExpression} UTC).`
      );
      return scheduledTask;
    },

    stop() {
      if (scheduledTask) {
        scheduledTask.stop?.();
        scheduledTask.destroy?.();
        scheduledTask = null;
      }
    },
  };
}

export const bookingLifecycleCronService = createBookingLifecycleCronService();
