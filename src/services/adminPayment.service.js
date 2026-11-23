import { ObjectId } from "mongodb";

import { ALLOWED_PAYMENT_STATUSES, PAYMENT_STATUSES } from "../constants/payment.js";
import {
  getBookingsCollection,
  getEquipmentCollection,
  getPaymentsCollection,
  getUsersCollection,
} from "../models/collections.js";
import {
  buildUserLookupFilter,
  resolveUserIdentifier,
} from "../models/user.model.js";
import { validateAdminPaymentListQuery } from "../validators/adminPayment.validator.js";
import { isValidObjectId } from "../validators/validationHelpers.js";

const SORT_SPECS = Object.freeze({
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  amount_high: { amount: -1, _id: -1 },
  amount_low: { amount: 1, _id: 1 },
});

function toIdVariants(rawId) {
  const text = String(rawId ?? "").trim();
  if (!text) return [];
  const variants = [text];
  if (isValidObjectId(text)) {
    variants.push(new ObjectId(text));
  }
  return variants;
}

function idString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function toIso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatUserSummary(userDoc, fallbackId) {
  if (!userDoc) {
    return {
      id: idString(fallbackId),
      name: "Unknown user",
      email: "",
      phone: "",
      role: "",
    };
  }
  return {
    id: idString(resolveUserIdentifier(userDoc) || userDoc._id || fallbackId),
    name: String(userDoc.name || userDoc.email || "Unknown user"),
    email: String(userDoc.email || ""),
    phone: String(userDoc.phone || ""),
    role: String(userDoc.role || ""),
  };
}

function formatPaymentRecord(doc, { userMap, equipmentMap, bookingMap }) {
  if (!doc || typeof doc !== "object") return null;

  const booking = bookingMap.get(idString(doc.bookingId)) || null;
  const equipment = equipmentMap.get(idString(doc.equipmentId)) || null;

  return {
    _id: idString(doc._id),
    status: ALLOWED_PAYMENT_STATUSES.includes(doc.status)
      ? doc.status
      : PAYMENT_STATUSES.PENDING,
    amount: safeNumber(doc.amount),
    currency: String(doc.currency || "BDT").toUpperCase(),
    provider: String(doc.provider || "stripe"),
    stripeCheckoutSessionId: String(doc.stripeCheckoutSessionId || ""),
    stripePaymentIntentId: String(doc.stripePaymentIntentId || ""),
    paidAt: toIso(doc.paidAt),
    createdAt: toIso(doc.createdAt),
    customer: formatUserSummary(userMap.get(idString(doc.customerId)), doc.customerId),
    owner: formatUserSummary(userMap.get(idString(doc.ownerId)), doc.ownerId),
    equipment: {
      id: idString(doc.equipmentId),
      name: String(equipment?.name || "Removed equipment"),
      category: String(equipment?.category || ""),
      image: String(equipment?.image || ""),
    },
    booking: booking
      ? {
          id: idString(booking._id),
          startDate: toIso(booking.startDate),
          endDate: toIso(booking.endDate),
          quantity: safeNumber(booking.quantity),
          rentalType: String(booking.rentalType || ""),
          bookingStatus: String(booking.bookingStatus || ""),
          paymentStatus: String(booking.paymentStatus || ""),
          totalAmount: safeNumber(booking.totalAmount),
          contactNumber: String(booking.contactNumber || ""),
          deliveryAddress: String(booking.deliveryAddress || ""),
        }
      : {
          id: idString(doc.bookingId),
          startDate: null,
          endDate: null,
          quantity: 0,
          rentalType: "",
          bookingStatus: "",
          paymentStatus: "",
          totalAmount: 0,
          contactNumber: "",
          deliveryAddress: "",
        },
  };
}

async function hydrateUsers(usersCollection, ids) {
  const unique = [...new Set(ids.map(idString).filter(Boolean))];
  const map = new Map();
  if (unique.length === 0) return map;

  const orClauses = unique.flatMap((id) => buildUserLookupFilter(id).$or);
  const docs = await usersCollection.find({ $or: orClauses }).toArray();
  for (const doc of docs) {
    const resolved = resolveUserIdentifier(doc);
    if (resolved) map.set(idString(resolved), doc);
    if (doc._id !== undefined && doc._id !== null) map.set(idString(doc._id), doc);
    if (doc.id !== undefined && doc.id !== null) map.set(idString(doc.id), doc);
  }
  return map;
}

async function hydrateByObjectIds(collection, ids) {
  const unique = [...new Set(ids.map(idString).filter((id) => isValidObjectId(id)))];
  const map = new Map();
  if (unique.length === 0) return map;

  const docs = await collection
    .find({ _id: { $in: unique.map((id) => new ObjectId(id)) } })
    .toArray();
  for (const doc of docs) {
    map.set(idString(doc._id), doc);
  }
  return map;
}

/**
 * Factory creating the Admin platform-wide payment history service.
 * Read-only by design: payment state is only ever mutated by Stripe-verified finalization.
 */
export function createAdminPaymentService({
  paymentsCollectionGetter = getPaymentsCollection,
  usersCollectionGetter = getUsersCollection,
  equipmentCollectionGetter = getEquipmentCollection,
  bookingsCollectionGetter = getBookingsCollection,
} = {}) {
  return {
    async listPayments(rawQuery = {}) {
      const { escapedSearch, status, sort, customerId, page, limit, skip } =
        validateAdminPaymentListQuery(rawQuery);

      const [
        paymentsCollection,
        usersCollection,
        equipmentCollection,
        bookingsCollection,
      ] = await Promise.all([
        paymentsCollectionGetter(),
        usersCollectionGetter(),
        equipmentCollectionGetter(),
        bookingsCollectionGetter(),
      ]);

      const clauses = [];
      if (status !== "all") {
        clauses.push({ status });
      }
      if (customerId) {
        clauses.push({ customerId: { $in: toIdVariants(customerId) } });
      }

      if (escapedSearch) {
        const rx = { $regex: escapedSearch, $options: "i" };
        const [matchedUsers, matchedEquipment] = await Promise.all([
          usersCollection
            .find({ $or: [{ name: rx }, { email: rx }] })
            .toArray(),
          equipmentCollection.find({ name: rx }).toArray(),
        ]);

        const userVariants = matchedUsers.flatMap((user) => [
          ...toIdVariants(resolveUserIdentifier(user)),
          ...toIdVariants(user._id),
        ]);
        const equipmentIds = matchedEquipment.map((item) => item._id);

        const orClauses = [
          { stripeCheckoutSessionId: rx },
          { stripePaymentIntentId: rx },
        ];
        if (userVariants.length > 0) {
          orClauses.push({ customerId: { $in: userVariants } });
          orClauses.push({ ownerId: { $in: userVariants } });
        }
        if (equipmentIds.length > 0) {
          orClauses.push({ equipmentId: { $in: equipmentIds } });
        }
        clauses.push({ $or: orClauses });
      }

      const filter = clauses.length === 0 ? {} : { $and: clauses };

      const [totalItems, docs, groupedTotals] = await Promise.all([
        paymentsCollection.countDocuments(filter),
        paymentsCollection
          .find(filter)
          .sort(SORT_SPECS[sort])
          .skip(skip)
          .limit(limit)
          .toArray(),
        paymentsCollection
          .aggregate([
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
                amount: { $sum: "$amount" },
              },
            },
          ])
          .toArray(),
      ]);

      const [userMap, equipmentMap, bookingMap] = await Promise.all([
        hydrateUsers(
          usersCollection,
          docs.flatMap((doc) => [doc.customerId, doc.ownerId])
        ),
        hydrateByObjectIds(
          equipmentCollection,
          docs.map((doc) => doc.equipmentId)
        ),
        hydrateByObjectIds(
          bookingsCollection,
          docs.map((doc) => doc.bookingId)
        ),
      ]);

      const summary = {
        totalPayments: 0,
        paidCount: 0,
        paidRevenue: 0,
        pendingCount: 0,
        failedCount: 0,
        refundedCount: 0,
        refundedAmount: 0,
      };
      for (const group of groupedTotals) {
        const count = safeNumber(group.count);
        const amount = safeNumber(group.amount);
        summary.totalPayments += count;
        if (group._id === PAYMENT_STATUSES.PAID) {
          summary.paidCount = count;
          summary.paidRevenue = amount;
        } else if (group._id === PAYMENT_STATUSES.PENDING) {
          summary.pendingCount = count;
        } else if (group._id === PAYMENT_STATUSES.FAILED) {
          summary.failedCount = count;
        } else if (group._id === PAYMENT_STATUSES.REFUNDED) {
          summary.refundedCount = count;
          summary.refundedAmount = amount;
        }
      }

      return {
        payments: docs
          .map((doc) =>
            formatPaymentRecord(doc, { userMap, equipmentMap, bookingMap })
          )
          .filter(Boolean),
        pagination: {
          currentPage: page,
          limit,
          totalItems,
          totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / limit),
        },
        summary,
      };
    },
  };
}

export const adminPaymentService = createAdminPaymentService();
