import { BOOKING_STATUSES } from "../constants/booking.js";
import { DEFAULT_CURRENCY, PAYMENT_STATUSES } from "../constants/payment.js";
import { COLLECTIONS } from "../models/collections.js";
import { formatCustomerBookingRecord } from "../models/bookingIntent.model.js";
import {
  buildUserLookupFilter,
  resolveUserIdentifier,
} from "../models/user.model.js";
import { escapeRegexInput } from "../utils/regex.js";
import { calculateInclusiveDays, formatUTCDateOnly } from "../utils/rentalDate.js";
import { isValidObjectId, toObjectId } from "../validators/validationHelpers.js";
import { RENTAL_SORT_MAP } from "../validators/rentalQuery.validator.js";

export const SAFE_RENTAL_USER_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  email: 1,
  image: 1,
});

const PAYMENT_PRIORITY = Object.freeze({
  [PAYMENT_STATUSES.PAID]: 4,
  [PAYMENT_STATUSES.REFUNDED]: 3,
  [PAYMENT_STATUSES.PENDING]: 2,
  [PAYMENT_STATUSES.FAILED]: 1,
});

/**
 * Selects the authoritative payment record when a booking has multiple payment attempts
 * so booking rows never multiply via payment joins.
 */
export function selectAuthoritativePayment(paymentDocs) {
  if (!Array.isArray(paymentDocs) || paymentDocs.length === 0) {
    return null;
  }
  if (paymentDocs.length === 1) {
    return paymentDocs[0];
  }

  return [...paymentDocs].sort((a, b) => {
    const pDiff =
      (PAYMENT_PRIORITY[b?.status] || 0) - (PAYMENT_PRIORITY[a?.status] || 0);
    if (pDiff !== 0) return pDiff;
    const at = a?.paidAt instanceof Date ? a.paidAt.getTime() : a?.createdAt instanceof Date ? a.createdAt.getTime() : 0;
    const bt = b?.paidAt instanceof Date ? b.paidAt.getTime() : b?.createdAt instanceof Date ? b.createdAt.getTime() : 0;
    return bt - at;
  })[0];
}

/**
 * Batch-hydrates users via $or ObjectId/string identifiers in one query (never N+1),
 * returning only safe public/dashboard fields (never password hashes, sessions, or secrets).
 */
export async function hydrateRentalUsersByIds(usersCollection, userIds = []) {
  const uniqueIds = [
    ...new Set(userIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ];
  if (uniqueIds.length === 0) return new Map();

  const orClauses = uniqueIds.flatMap((id) => buildUserLookupFilter(id).$or);
  const docs = await usersCollection
    .find({ $or: orClauses }, { projection: SAFE_RENTAL_USER_PROJECTION })
    .toArray();

  const map = new Map();
  for (const doc of docs) {
    const resolved = resolveUserIdentifier(doc);
    if (resolved) map.set(resolved, doc);
    if (doc._id !== undefined && doc._id !== null) map.set(String(doc._id), doc);
    if (doc.id !== undefined && doc.id !== null) map.set(String(doc.id), doc);
  }
  return map;
}

/**
 * Finds all user ID strings matching a text search for Owner/Admin search queries.
 */
export async function findMatchingUserIdentifiers(usersCollection, search) {
  const cleanSearch = String(search || "").trim();
  if (!cleanSearch) return [];

  const pattern = escapeRegexInput(cleanSearch);
  const matched = await usersCollection
    .find(
      { name: { $regex: pattern, $options: "i" } },
      { projection: { _id: 1, id: 1 } }
    )
    .toArray();

  const ids = new Set();
  for (const doc of matched) {
    const resolved = resolveUserIdentifier(doc);
    if (resolved) ids.add(resolved);
    if (doc._id !== undefined && doc._id !== null) ids.add(String(doc._id));
    if (doc.id !== undefined && doc.id !== null) ids.add(String(doc.id));
  }
  return [...ids];
}

export function buildOwnerMatchVariants(ownerId) {
  const variants = [{ ownerId: String(ownerId) }];
  if (isValidObjectId(String(ownerId))) {
    variants.push({ ownerId: toObjectId(String(ownerId), "ownerId") });
  }
  return variants;
}

export function buildUserIdMatchCandidates(userId) {
  const candidates = [String(userId)];
  if (isValidObjectId(String(userId))) {
    candidates.push(toObjectId(String(userId), "userId"));
  }
  return candidates;
}

function buildRentalSearchClauses({
  search,
  matchedUserIds = [],
  includeCustomerSearch = false,
  includeOwnerSearch = false,
}) {
  if (!search) return null;

  const pattern = escapeRegexInput(search);
  const orClauses = [
    { "equipmentDoc.name": { $regex: pattern, $options: "i" } },
    { "equipmentDoc.category": { $regex: pattern, $options: "i" } },
  ];

  if (isValidObjectId(search)) {
    orClauses.push({ _id: toObjectId(search, "bookingId") });
  }

  if (matchedUserIds.length > 0) {
    const expandedIds = matchedUserIds.flatMap((id) =>
      buildUserIdMatchCandidates(id)
    );
    if (includeCustomerSearch) {
      orClauses.push({ customerId: { $in: expandedIds } });
    }
    if (includeOwnerSearch) {
      orClauses.push({ ownerId: { $in: expandedIds } });
    }
  }

  return { $or: orClauses };
}

/**
 * Executes shared paginated rental aggregation against `bookings` only
 * (temporary `bookingIntents` never enter finalized rental queries).
 */
export async function executeRentalListAggregation({
  bookingsCollection,
  usersCollection = null,
  earlyMatch = {},
  validatedQuery,
  includeCustomerSearch = false,
  includeOwnerSearch = false,
  hydrateCustomer = false,
  hydrateOwner = false,
  includeSummary = false,
}) {
  const matchFilter = { ...earlyMatch };
  if (validatedQuery.bookingStatus !== "all") {
    matchFilter.bookingStatus = validatedQuery.bookingStatus;
  }
  if (validatedQuery.paymentStatus !== "all") {
    matchFilter.paymentStatus = validatedQuery.paymentStatus;
  }
  if (validatedQuery.equipmentId) {
    matchFilter.equipmentId = validatedQuery.equipmentId;
  }
  if (validatedQuery.customerId) {
    const custCandidates = buildUserIdMatchCandidates(validatedQuery.customerId);
    matchFilter.customerId =
      custCandidates.length === 1 ? custCandidates[0] : { $in: custCandidates };
  }
  if (validatedQuery.ownerId) {
    const ownerCandidates = buildUserIdMatchCandidates(validatedQuery.ownerId);
    matchFilter.ownerId =
      ownerCandidates.length === 1 ? ownerCandidates[0] : { $in: ownerCandidates };
  }

  let matchedUserIds = [];
  if (
    validatedQuery.search &&
    usersCollection &&
    (includeCustomerSearch || includeOwnerSearch)
  ) {
    matchedUserIds = await findMatchingUserIdentifiers(
      usersCollection,
      validatedQuery.search
    );
  }

  const pipeline = [
    { $match: matchFilter },
    {
      $lookup: {
        from: COLLECTIONS.EQUIPMENT,
        localField: "equipmentId",
        foreignField: "_id",
        as: "equipmentDoc",
      },
    },
    {
      $unwind: {
        path: "$equipmentDoc",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      // Kept as array without $unwind so multiple payment attempts never multiply booking rows
      $lookup: {
        from: COLLECTIONS.PAYMENTS,
        localField: "_id",
        foreignField: "bookingId",
        as: "paymentDocs",
      },
    },
  ];

  const searchFilter = buildRentalSearchClauses({
    search: validatedQuery.search,
    matchedUserIds,
    includeCustomerSearch,
    includeOwnerSearch,
  });
  if (searchFilter) {
    pipeline.push({ $match: searchFilter });
  }

  pipeline.push(
    {
      $project: {
        _id: 1,
        customerId: 1,
        ownerId: 1,
        equipmentId: 1,
        startDate: 1,
        endDate: 1,
        quantity: 1,
        rentalType: 1,
        rentalPrice: 1,
        totalAmount: 1,
        currency: 1,
        paymentStatus: 1,
        bookingStatus: 1,
        createdAt: 1,
        equipmentDoc: {
          _id: "$equipmentDoc._id",
          name: "$equipmentDoc.name",
          image: "$equipmentDoc.image",
          category: "$equipmentDoc.category",
          location: "$equipmentDoc.location",
          rentalType: "$equipmentDoc.rentalType",
        },
        paymentDocs: 1,
      },
    },
    { $sort: validatedQuery.sortOptions || RENTAL_SORT_MAP.newest },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        items: [{ $skip: validatedQuery.skip }, { $limit: validatedQuery.limit }],
      },
    }
  );

  const summaryPipeline = includeSummary
    ? [
        { $match: earlyMatch },
        {
          $group: {
            _id: null,
            totalBookings: { $sum: 1 },
            pendingBookings: {
              $sum: {
                $cond: [
                  {
                    $in: [
                      "$bookingStatus",
                      [BOOKING_STATUSES.PENDING, BOOKING_STATUSES.CONFIRMED],
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            activeRentals: {
              $sum: {
                $cond: [{ $eq: ["$bookingStatus", BOOKING_STATUSES.ACTIVE] }, 1, 0],
              },
            },
            completedRentals: {
              $sum: {
                $cond: [{ $eq: ["$bookingStatus", BOOKING_STATUSES.COMPLETED] }, 1, 0],
              },
            },
            cancelledBookings: {
              $sum: {
                $cond: [{ $eq: ["$bookingStatus", BOOKING_STATUSES.CANCELLED] }, 1, 0],
              },
            },
          },
        },
      ]
    : null;

  const [aggregated, summaryAgg] = await Promise.all([
    bookingsCollection.aggregate(pipeline).toArray(),
    summaryPipeline
      ? bookingsCollection.aggregate(summaryPipeline).toArray().catch(() => [])
      : Promise.resolve([]),
  ]);

  const facetResult = aggregated[0] || {};
  const totalItems = Number(facetResult.metadata?.[0]?.total) || 0;
  const docs = Array.isArray(facetResult.items) ? facetResult.items : [];

  let userMap = new Map();
  if (usersCollection && (hydrateCustomer || hydrateOwner) && docs.length > 0) {
    const idsToLoad = [];
    for (const doc of docs) {
      if (hydrateCustomer && doc.customerId) idsToLoad.push(doc.customerId);
      if (hydrateOwner && doc.ownerId) idsToLoad.push(doc.ownerId);
    }
    userMap = await hydrateRentalUsersByIds(usersCollection, idsToLoad);
  }

  let summary = null;
  if (includeSummary) {
    const s = summaryAgg[0] || {};
    summary = {
      totalBookings: Number(s.totalBookings) || 0,
      pendingBookings: Number(s.pendingBookings) || 0,
      activeRentals: Number(s.activeRentals) || 0,
      completedRentals: Number(s.completedRentals) || 0,
      cancelledBookings: Number(s.cancelledBookings) || 0,
    };
  }

  return {
    docs,
    userMap,
    summary,
    pagination: {
      currentPage: validatedQuery.page,
      limit: validatedQuery.limit,
      totalItems,
      totalPages:
        totalItems === 0 ? 0 : Math.ceil(totalItems / validatedQuery.limit),
    },
  };
}

/**
 * Formats a finalized rental record cleanly for Customer, Owner, or Admin roles,
 * never exposing sensitive credentials or unnecessary personal fields.
 */
export function formatRoleRentalRecord(
  doc,
  { role = "Customer", userMap = new Map(), detailed = false } = {}
) {
  if (!doc || typeof doc !== "object") return null;

  const authPayment =
    selectAuthoritativePayment(doc.paymentDocs) || doc.paymentDoc || null;

  if (role === "Customer") {
    return formatCustomerBookingRecord(
      { ...doc, paymentDoc: authPayment },
      { detailed }
    );
  }

  const eq =
    doc.equipmentDoc && typeof doc.equipmentDoc === "object" ? doc.equipmentDoc : {};
  const startDateObj =
    doc.startDate instanceof Date ? doc.startDate : new Date(doc.startDate);
  const endDateObj =
    doc.endDate instanceof Date ? doc.endDate : new Date(doc.endDate);
  const durationDays = calculateInclusiveDays(startDateObj, endDateObj);

  const equipmentId = eq._id
    ? String(eq._id)
    : doc.equipmentId
      ? String(doc.equipmentId)
      : "";
  const equipmentName = eq.name || "Equipment Item";
  const equipmentImage = eq.image || "";
  const category = eq.category || "";
  const location = eq.location || "";

  const customerUser = userMap.get(String(doc.customerId || "")) || null;
  const ownerUser = userMap.get(String(doc.ownerId || "")) || null;

  const paymentStatus = authPayment?.status || doc.paymentStatus || PAYMENT_STATUSES.PENDING;

  const base = {
    _id: doc._id ? String(doc._id) : "",
    bookingReference: doc._id ? String(doc._id) : "",
    createdAt: doc.createdAt || null,
    equipmentId,
    equipmentName,
    equipmentImage,
    category,
    equipment: {
      _id: equipmentId,
      name: equipmentName,
      image: equipmentImage,
      category,
      ...(role === "Admin" || detailed ? { location } : {}),
    },
    customer: {
      id: doc.customerId ? String(doc.customerId) : "",
      name: customerUser?.name || "Verified Customer",
      email: customerUser?.email || "",
      image: customerUser?.image || null,
      photoURL: customerUser?.image || "",
    },
    startDate: formatUTCDateOnly(startDateObj),
    endDate: formatUTCDateOnly(endDateObj),
    durationDays,
    quantity: Number(doc.quantity) || 0,
    rentalType: doc.rentalType || eq.rentalType || "",
    rentalPrice: Number(doc.rentalPrice) || 0,
    totalAmount: Number(doc.totalAmount) || 0,
    currency: doc.currency || DEFAULT_CURRENCY,
    paymentStatus,
    bookingStatus: doc.bookingStatus || BOOKING_STATUSES.PENDING,
    transactionId: authPayment?.stripePaymentIntentId || "",
    paidAt: authPayment?.paidAt || null,
  };

  if (role === "Owner" && detailed) {
    base.contactNumber = doc.contactNumber || "";
    base.deliveryAddress = doc.deliveryAddress || "";
    base.additionalNotes = doc.additionalNotes || "";
  }

  if (role === "Admin") {
    base.owner = {
      id: doc.ownerId ? String(doc.ownerId) : "",
      name: ownerUser?.name || "Listing Owner",
      email: ownerUser?.email || "",
      image: ownerUser?.image || null,
      photoURL: ownerUser?.image || "",
    };

    if (detailed) {
      base.stripeCheckoutSessionId = authPayment?.stripeCheckoutSessionId || "";
      base.stripePaymentIntentId = authPayment?.stripePaymentIntentId || "";
      base.paymentIntentId = authPayment?.stripePaymentIntentId || "";
      base.refundStatus =
        paymentStatus === PAYMENT_STATUSES.REFUNDED ? PAYMENT_STATUSES.REFUNDED : null;
      base.contactNumber = doc.contactNumber || "";
      base.deliveryAddress = doc.deliveryAddress || "";
      base.additionalNotes = doc.additionalNotes || "";
    }
  }

  return base;
}
