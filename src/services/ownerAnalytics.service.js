import { BOOKING_STATUSES } from "../constants/booking.js";
import { EQUIPMENT_STATUSES } from "../constants/equipment.js";
import {
  DEFAULT_CURRENCY,
  PAYMENT_STATUSES,
  roundCurrency,
} from "../constants/payment.js";
import {
  getBookingsCollection,
  getEquipmentCollection,
  getPaymentsCollection,
  getUsersCollection,
} from "../models/collections.js";
import { resolveUserIdentifier } from "../models/user.model.js";
import {
  buildUserIdMatchCandidates,
  hydrateRentalUsersByIds,
} from "./rentalAggregation.service.js";
import {
  getAnalyticsMonthWindow,
  zeroFillMonthlySeries,
} from "../utils/analyticsDate.js";
import { ApiError } from "../utils/ApiError.js";
import { calculateInclusiveDays } from "../utils/rentalDate.js";
import { buildAuthoritativePaidPaymentStages } from "../utils/revenueCalculator.js";
import { validateAnalyticsQuery } from "../validators/analytics.validator.js";

const TOP_EQUIPMENT_PERFORMANCE_LIMIT = 5;
const RECENT_OWNER_RENTALS_LIMIT = 5;

function buildOwnerIdAndEquipmentScope({
  ownerCandidates,
  equipmentIdCandidates = [],
  bookingIdCandidates = [],
}) {
  const orClauses = [{ ownerId: { $in: ownerCandidates } }];
  if (equipmentIdCandidates.length > 0) {
    orClauses.push({ equipmentId: { $in: equipmentIdCandidates } });
  }
  if (bookingIdCandidates.length > 0) {
    orClauses.push({ bookingId: { $in: bookingIdCandidates } });
  }

  return orClauses.length === 1 ? orClauses[0] : { $or: orClauses };
}

function collectIdCandidates(ids = []) {
  const seen = new Map();
  for (const id of ids) {
    if (id === undefined || id === null) continue;
    for (const candidate of buildUserIdMatchCandidates(id)) {
      const key =
        typeof candidate === "object" && candidate !== null
          ? `oid:${String(candidate)}`
          : `str:${String(candidate)}`;
      if (!seen.has(key)) {
        seen.set(key, candidate);
      }
    }
  }
  return [...seen.values()];
}

function computeSafeDurationDays(booking) {
  const numericDuration = Number(booking?.durationDays);
  if (Number.isInteger(numericDuration) && numericDuration > 0) {
    return numericDuration;
  }

  try {
    if (booking?.startDate && booking?.endDate) {
      return calculateInclusiveDays(booking.startDate, booking.endDate);
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Factory creating Owner-scoped business & revenue analytics service backed by MongoDB aggregation.
 */
export function createOwnerAnalyticsService({
  equipmentCollectionGetter = getEquipmentCollection,
  bookingsCollectionGetter = getBookingsCollection,
  paymentsCollectionGetter = getPaymentsCollection,
  usersCollectionGetter = getUsersCollection,
  nowProvider = () => new Date(),
} = {}) {
  return {
    async getOwnerAnalytics({ ownerId, query = {} }) {
      const normalizedOwnerId = String(ownerId || "").trim();
      if (!normalizedOwnerId) {
        throw new ApiError("Authentication required", 401, {
          code: "UNAUTHORIZED",
        });
      }

      const { period, monthsCount } = validateAnalyticsQuery(query);
      const { windowStart, currentMonthStart, nextMonthStart, months } =
        getAnalyticsMonthWindow(monthsCount, nowProvider());

      const [
        equipmentCollection,
        bookingsCollection,
        paymentsCollection,
        usersCollection,
      ] = await Promise.all([
        equipmentCollectionGetter(),
        bookingsCollectionGetter(),
        paymentsCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const ownerCandidates = buildUserIdMatchCandidates(normalizedOwnerId);

      // Include historical archived equipment IDs when scoping past bookings/payments,
      // while reporting active fleet metrics solely from non-deleted listings.
      const allOwnerEquipmentDocs = await equipmentCollection
        .find(
          { ownerId: { $in: ownerCandidates } },
          {
            projection: {
              _id: 1,
              name: 1,
              image: 1,
              images: 1,
              category: 1,
              rentalPrice: 1,
              rentalType: 1,
              status: 1,
              availableQuantity: 1,
              isDeleted: 1,
              createdAt: 1,
            },
          }
        )
        .toArray();

      const activeEquipmentDocs = allOwnerEquipmentDocs.filter(
        (doc) => doc.isDeleted !== true
      );
      const equipmentById = new Map(
        allOwnerEquipmentDocs.map((doc) => [String(doc._id), doc])
      );
      const ownedEquipmentIdCandidates = collectIdCandidates(
        allOwnerEquipmentDocs.map((doc) => doc._id)
      );

      const bookingScopeMatch = buildOwnerIdAndEquipmentScope({
        ownerCandidates,
        equipmentIdCandidates: ownedEquipmentIdCandidates,
      });

      const [bookingFacetDocs, ownerBookingLinks, recentBookingDocs] =
        await Promise.all([
          bookingsCollection
            .aggregate([
              { $match: bookingScopeMatch },
              {
                $facet: {
                  totals: [
                    {
                      $group: {
                        _id: null,
                        totalBookings: { $sum: 1 },
                        completedRentals: {
                          $sum: {
                            $cond: [
                              { $eq: ["$bookingStatus", BOOKING_STATUSES.COMPLETED] },
                              1,
                              0,
                            ],
                          },
                        },
                        grossBookingVolume: {
                          $sum: {
                            $cond: [
                              {
                                $and: [
                                  { $ne: ["$bookingStatus", BOOKING_STATUSES.CANCELLED] },
                                  { $eq: ["$paymentStatus", PAYMENT_STATUSES.PAID] },
                                  { $isNumber: "$totalAmount" },
                                ],
                              },
                              "$totalAmount",
                              0,
                            ],
                          },
                        },
                      },
                    },
                  ],
                  monthlySeries: [
                    {
                      $match: {
                        createdAt: {
                          $gte: windowStart,
                          $lt: nextMonthStart,
                        },
                      },
                    },
                    {
                      $group: {
                        _id: {
                          $dateToString: {
                            format: "%Y-%m",
                            date: "$createdAt",
                            timezone: "UTC",
                          },
                        },
                        totalBookings: { $sum: 1 },
                        completedRentals: {
                          $sum: {
                            $cond: [
                              { $eq: ["$bookingStatus", BOOKING_STATUSES.COMPLETED] },
                              1,
                              0,
                            ],
                          },
                        },
                      },
                    },
                    { $sort: { _id: 1 } },
                  ],
                  byEquipment: [
                    {
                      $match: {
                        equipmentId: { $ne: null },
                      },
                    },
                    {
                      $group: {
                        _id: { $toString: "$equipmentId" },
                        rentalsCount: { $sum: 1 },
                        completedRentals: {
                          $sum: {
                            $cond: [
                              { $eq: ["$bookingStatus", BOOKING_STATUSES.COMPLETED] },
                              1,
                              0,
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            ])
            .toArray(),
          bookingsCollection
            .find(bookingScopeMatch, { projection: { _id: 1, equipmentId: 1 } })
            .toArray(),
          bookingsCollection
            .find(bookingScopeMatch, {
              projection: {
                _id: 1,
                customerId: 1,
                equipmentId: 1,
                startDate: 1,
                endDate: 1,
                durationDays: 1,
                quantity: 1,
                totalAmount: 1,
                paymentStatus: 1,
                bookingStatus: 1,
                createdAt: 1,
              },
            })
            .sort({ createdAt: -1, _id: -1 })
            .limit(RECENT_OWNER_RENTALS_LIMIT)
            .toArray(),
        ]);

      const bookingToEquipmentIdMap = new Map();
      for (const link of ownerBookingLinks) {
        if (link?._id && link?.equipmentId) {
          bookingToEquipmentIdMap.set(String(link._id), String(link.equipmentId));
        }
      }

      const ownedBookingIdCandidates = collectIdCandidates(
        ownerBookingLinks.map((link) => link._id)
      );
      const paymentScopeMatch = buildOwnerIdAndEquipmentScope({
        ownerCandidates,
        equipmentIdCandidates: ownedEquipmentIdCandidates,
        bookingIdCandidates: ownedBookingIdCandidates,
      });

      const [paymentFacetDocs, customerMap] = await Promise.all([
        paymentsCollection
          .aggregate([
            ...buildAuthoritativePaidPaymentStages(paymentScopeMatch),
            {
              $facet: {
                allTime: [
                  {
                    $group: {
                      _id: null,
                      totalEarnings: { $sum: "$netAmount" },
                    },
                  },
                ],
                currentMonth: [
                  {
                    $match: {
                      effectivePaidAt: {
                        $gte: currentMonthStart,
                        $lt: nextMonthStart,
                      },
                    },
                  },
                  {
                    $group: {
                      _id: null,
                      total: { $sum: "$netAmount" },
                    },
                  },
                ],
                monthlySeries: [
                  {
                    $match: {
                      effectivePaidAt: {
                        $gte: windowStart,
                        $lt: nextMonthStart,
                      },
                    },
                  },
                  {
                    $group: {
                      _id: {
                        $dateToString: {
                          format: "%Y-%m",
                          date: "$effectivePaidAt",
                          timezone: "UTC",
                        },
                      },
                      earnings: { $sum: "$netAmount" },
                    },
                  },
                  { $sort: { _id: 1 } },
                ],
                byBookingOrEquipment: [
                  {
                    $group: {
                      _id: {
                        bookingId: {
                          $cond: [
                            { $ne: ["$_id", null] },
                            { $toString: "$_id" },
                            null,
                          ],
                        },
                        equipmentId: {
                          $cond: [
                            { $ne: ["$equipmentId", null] },
                            { $toString: "$equipmentId" },
                            null,
                          ],
                        },
                      },
                      earningsGenerated: { $sum: "$netAmount" },
                    },
                  },
                ],
              },
            },
          ])
          .toArray(),
        hydrateRentalUsersByIds(
          usersCollection,
          recentBookingDocs.map((doc) => resolveUserIdentifier(doc.customerId) || doc.customerId)
        ),
      ]);

      const equipmentStatusBreakdown = {
        approved: 0,
        pending: 0,
        rejected: 0,
      };
      for (const item of activeEquipmentDocs) {
        if (item.status === EQUIPMENT_STATUSES.APPROVED) {
          equipmentStatusBreakdown.approved += 1;
        } else if (item.status === EQUIPMENT_STATUSES.PENDING) {
          equipmentStatusBreakdown.pending += 1;
        } else if (item.status === EQUIPMENT_STATUSES.REJECTED) {
          equipmentStatusBreakdown.rejected += 1;
        }
      }

      const bookingFacet = bookingFacetDocs?.[0] || {};
      const bookingTotals = bookingFacet.totals?.[0] || {};
      const bookingMonthMap = new Map(
        (bookingFacet.monthlySeries || []).map((row) => [
          String(row._id),
          {
            totalBookings: Math.max(0, Math.floor(Number(row.totalBookings || 0))),
            completedRentals: Math.max(
              0,
              Math.floor(Number(row.completedRentals || 0))
            ),
          },
        ])
      );

      const bookingStatsByEquipment = new Map(
        (bookingFacet.byEquipment || []).map((row) => [
          String(row._id),
          {
            rentalsCount: Math.max(0, Math.floor(Number(row.rentalsCount || 0))),
            completedRentals: Math.max(
              0,
              Math.floor(Number(row.completedRentals || 0))
            ),
          },
        ])
      );

      const paymentFacet = paymentFacetDocs?.[0] || {};
      const paymentTotals = paymentFacet.allTime?.[0] || {};
      const paymentCurrentMonth = paymentFacet.currentMonth?.[0] || {};
      const earningsMonthMap = new Map(
        (paymentFacet.monthlySeries || []).map((row) => [
          String(row._id),
          roundCurrency(Math.max(0, Number(row.earnings || 0))),
        ])
      );

      const earningsByEquipment = new Map();
      for (const row of paymentFacet.byBookingOrEquipment || []) {
        const directEquipmentId = row?._id?.equipmentId
          ? String(row._id.equipmentId)
          : "";
        const bookingId = row?._id?.bookingId ? String(row._id.bookingId) : "";
        const resolvedEquipmentId =
          directEquipmentId || bookingToEquipmentIdMap.get(bookingId) || "";
        if (!resolvedEquipmentId) continue;

        const prev = earningsByEquipment.get(resolvedEquipmentId) || 0;
        earningsByEquipment.set(
          resolvedEquipmentId,
          roundCurrency(prev + Math.max(0, Number(row.earningsGenerated || 0)))
        );
      }

      const monthlyEarningsData = zeroFillMonthlySeries(
        months,
        earningsMonthMap,
        (slot, earningsAmount) => ({
          month: slot.month,
          label: slot.label,
          yearMonth: slot.yearMonth,
          earnings: roundCurrency(Math.max(0, Number(earningsAmount || 0))),
        })
      );

      const monthlyRentalData = zeroFillMonthlySeries(
        months,
        bookingMonthMap,
        (slot, entry) => ({
          month: slot.month,
          label: slot.label,
          yearMonth: slot.yearMonth,
          totalBookings: entry?.totalBookings ?? 0,
          completedRentals: entry?.completedRentals ?? 0,
        })
      );

      const equipmentPerformance = activeEquipmentDocs
        .map((item) => {
          const itemId = String(item._id);
          const bookingStats = bookingStatsByEquipment.get(itemId);
          const earningsGenerated = earningsByEquipment.get(itemId) ?? 0;
          const availableQty = Number(item.availableQuantity ?? 0);

          return {
            _id: itemId,
            name: String(item.name || "Listed Equipment"),
            image:
              item.image ||
              (Array.isArray(item.images) ? item.images[0] : "") ||
              "",
            category: String(item.category || ""),
            rentalPrice: Number(item.rentalPrice ?? 0),
            rentalType: String(item.rentalType || "Daily"),
            approvalStatus: String(item.status || EQUIPMENT_STATUSES.PENDING),
            status: String(item.status || EQUIPMENT_STATUSES.PENDING),
            availableQuantity: Number.isFinite(availableQty) ? availableQty : 0,
            availabilityStatus:
              availableQty > 0 ? "Available" : "Unavailable",
            rentalsCount: bookingStats?.rentalsCount ?? 0,
            completedRentals: bookingStats?.completedRentals ?? 0,
            earningsGenerated,
            _createdAtTs: item.createdAt ? new Date(item.createdAt).getTime() : 0,
          };
        })
        .sort((a, b) => {
          if (b.earningsGenerated !== a.earningsGenerated) {
            return b.earningsGenerated - a.earningsGenerated;
          }
          if (b.rentalsCount !== a.rentalsCount) {
            return b.rentalsCount - a.rentalsCount;
          }
          return b._createdAtTs - a._createdAtTs;
        })
        .slice(0, TOP_EQUIPMENT_PERFORMANCE_LIMIT)
        .map(({ _createdAtTs, ...cleanItem }) => cleanItem);

      const recentRentals = recentBookingDocs.map((booking) => {
        const customer = customerMap.get(String(booking.customerId || ""));
        const equipment = equipmentById.get(String(booking.equipmentId || ""));

        return {
          _id: String(booking._id),
          bookingReference: String(booking._id),
          customerName: String(customer?.name || "Verified Customer"),
          equipment: {
            _id: booking.equipmentId ? String(booking.equipmentId) : "",
            name: String(equipment?.name || "Equipment Item"),
            image:
              equipment?.image ||
              (Array.isArray(equipment?.images) ? equipment.images[0] : "") ||
              "",
          },
          startDate: booking.startDate || "",
          endDate: booking.endDate || "",
          durationDays: computeSafeDurationDays(booking),
          quantity: Number.isInteger(Number(booking.quantity))
            ? Number(booking.quantity)
            : 1,
          bookingAmount: roundCurrency(
            Math.max(0, Number(booking.totalAmount || 0))
          ),
          paymentStatus: String(booking.paymentStatus || PAYMENT_STATUSES.PENDING),
          bookingStatus: String(booking.bookingStatus || BOOKING_STATUSES.PENDING),
          createdAt: booking.createdAt || "",
        };
      });

      return {
        period,
        currency: DEFAULT_CURRENCY,
        totalListedEquipment: activeEquipmentDocs.length,
        completedRentals: Math.max(
          0,
          Math.floor(Number(bookingTotals.completedRentals || 0))
        ),
        totalEarnings: roundCurrency(
          Math.max(0, Number(paymentTotals.totalEarnings || 0))
        ),
        monthlyEarnings: roundCurrency(
          Math.max(0, Number(paymentCurrentMonth.total || 0))
        ),
        grossBookingVolume: roundCurrency(
          Math.max(0, Number(bookingTotals.grossBookingVolume || 0))
        ),
        equipmentStatusBreakdown,
        monthlyEarningsData,
        monthlyRentalData,
        equipmentPerformance,
        recentRentals,
      };
    },
  };
}

export const ownerAnalyticsService = createOwnerAnalyticsService();
