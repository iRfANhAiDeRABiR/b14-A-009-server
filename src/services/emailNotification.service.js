import { mailer as defaultMailer } from "../config/mailer.js";
import {
  getBookingsCollection,
  getEquipmentCollection,
  getUsersCollection,
} from "../models/collections.js";
import {
  buildUserLookupFilter,
  SAFE_USER_PROJECTION,
} from "../models/user.model.js";
import { formatUTCDateOnly } from "../utils/rentalDate.js";

function buildCompletionEmailCopy({ recipientRole, equipmentName, booking, counterpartyName }) {
  const bookingRef = String(booking._id);
  const startStr = formatUTCDateOnly(
    booking.startDate instanceof Date ? booking.startDate : new Date(booking.startDate)
  );
  const endStr = formatUTCDateOnly(
    booking.endDate instanceof Date ? booking.endDate : new Date(booking.endDate)
  );

  const subject = `GearNest Rental Completed: ${equipmentName}`;
  const greeting =
    recipientRole === "Owner"
      ? `Your equipment rental for "${equipmentName}" (${bookingRef}) with customer ${counterpartyName} has reached its end date (${endStr}) and has been marked Completed.`
      : `Your rental for "${equipmentName}" (${bookingRef}) from ${startStr || "start"} through ${endStr || "end"} has been marked Completed.`;

  const text = `${greeting}\n\nThank you for using GearNest.`;
  return { subject, text };
}

/**
 * Reliable, non-blocking completion email dispatcher with atomic duplicate protection.
 * Skips silently when SMTP credentials are absent; never logs or exposes SMTP secrets.
 */
export function createEmailNotificationService({
  mailer = defaultMailer,
  bookingsCollectionGetter = getBookingsCollection,
  equipmentCollectionGetter = getEquipmentCollection,
  usersCollectionGetter = getUsersCollection,
  nowProvider = () => new Date(),
} = {}) {
  return {
    async notifyBookingCompleted({ booking }) {
      if (!booking?._id) {
        return { notified: false, status: "invalid_booking" };
      }

      const [bookingsCollection, equipmentCollection, usersCollection] =
        await Promise.all([
          bookingsCollectionGetter(),
          equipmentCollectionGetter(),
          usersCollectionGetter(),
        ]);

      const claimTime = nowProvider();

      // Atomic outbox claim guarantees repeat cron passes or concurrent instances
      // cannot send duplicate completion emails for the same booking.
      const claimResult = await bookingsCollection.findOneAndUpdate(
        {
          _id: booking._id,
          completionEmailSentAt: { $exists: false },
          completionEmailClaimedAt: { $exists: false },
        },
        {
          $set: {
            completionEmailClaimedAt: claimTime,
            completionEmailStatus: "pending",
          },
        },
        { returnDocument: "after" }
      );

      const claimed =
        claimResult && typeof claimResult === "object" && "value" in claimResult
          ? claimResult.value
          : claimResult;

      if (!claimed) {
        return { notified: false, status: "already_handled" };
      }

      if (!mailer.isConfigured()) {
        await bookingsCollection.updateOne(
          { _id: booking._id },
          {
            $set: {
              completionEmailStatus: "skipped",
              completionEmailNote: "SMTP credentials not configured",
              updatedAt: nowProvider(),
            },
          }
        );
        return { notified: false, status: "skipped" };
      }

      try {
        const [customerDoc, ownerDoc, equipmentDoc] = await Promise.all([
          booking.customerId
            ? usersCollection.findOne(buildUserLookupFilter(booking.customerId), {
                projection: SAFE_USER_PROJECTION,
              })
            : null,
          booking.ownerId
            ? usersCollection.findOne(buildUserLookupFilter(booking.ownerId), {
                projection: SAFE_USER_PROJECTION,
              })
            : null,
          booking.equipmentId
            ? equipmentCollection.findOne(
                { _id: booking.equipmentId },
                { projection: { _id: 1, name: 1 } }
              )
            : null,
        ]);

        const equipmentName = String(equipmentDoc?.name || "Equipment Rental");
        const deliveryResults = [];

        if (customerDoc?.email) {
          const customerCopy = buildCompletionEmailCopy({
            recipientRole: "Customer",
            equipmentName,
            booking,
            counterpartyName: ownerDoc?.name || "Equipment Owner",
          });
          deliveryResults.push(
            await mailer.sendMail({
              to: customerDoc.email,
              subject: customerCopy.subject,
              text: customerCopy.text,
            })
          );
        }

        if (ownerDoc?.email) {
          const ownerCopy = buildCompletionEmailCopy({
            recipientRole: "Owner",
            equipmentName,
            booking,
            counterpartyName: customerDoc?.name || "Verified Customer",
          });
          deliveryResults.push(
            await mailer.sendMail({
              to: ownerDoc.email,
              subject: ownerCopy.subject,
              text: ownerCopy.text,
            })
          );
        }

        const anySent = deliveryResults.some((r) => r.sent === true);
        const allFailed =
          deliveryResults.length > 0 && deliveryResults.every((r) => !r.sent && !r.skipped);
        const finalStatus = anySent ? "sent" : allFailed ? "failed" : "skipped";

        await bookingsCollection.updateOne(
          { _id: booking._id },
          {
            $set: {
              completionEmailStatus: finalStatus,
              ...(anySent ? { completionEmailSentAt: nowProvider() } : {}),
              updatedAt: nowProvider(),
            },
          }
        );

        return { notified: anySent, status: finalStatus };
      } catch (error) {
        await bookingsCollection
          .updateOne(
            { _id: booking._id },
            {
              $set: {
                completionEmailStatus: "failed",
                updatedAt: nowProvider(),
              },
            }
          )
          .catch(() => null);

        return {
          notified: false,
          status: "failed",
          error: error?.message || "Notification error",
        };
      }
    },
  };
}

export const emailNotificationService = createEmailNotificationService();
