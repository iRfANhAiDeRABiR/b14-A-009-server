import { BOOKING_STATUSES } from "../constants/booking.js";
import { EQUIPMENT_STATUSES } from "../constants/equipment.js";
import { DEFAULT_CURRENCY, roundCurrency } from "../constants/payment.js";
import {
  getBookingsCollection,
  getEquipmentCollection,
  getPaymentsCollection,
  getUsersCollection,
} from "../models/collections.js";
import {
  getAnalyticsMonthWindow,
  zeroFillMonthlySeries,
} from "../utils/analyticsDate.js";
import {
  buildAuthoritativePaidPaymentStages,
  calculateNetPaymentAmount,
} from "../utils/revenueCalculator.js";
import { validateAnalyticsQuery } from "../validators/analytics.validator.js";

const RECENT_ACTIVITY_SOURCE_LIMIT = 4;
const RECENT_ACTIVITY_TOTAL_LIMIT = 6;

const CANONICAL_APPROVAL_STATUSES = Object.freeze([
  EQUIPMENT_STATUSES.PENDING,
  EQUIPMENT_STATUSES.APPROVED,
  EQUIPMENT_STATUSES.REJECTED,
]);

function normalizeRecentActivityItems({ bookings = [], equipment = [], payments = [] }) {
  const events = [];

  for (const booking of bookings) {
    if (!booking?._id) continue;
    events.push({
      _id: String(booking._id),
      type: "booking",
      activityType: "Rental Booking",
      title: `Booking #${String(booking._id).slice(-6).toUpperCase()}`,
      reference: String(booking._id),
      status: String(booking.bookingStatus || BOOKING_STATUSES.PENDING),
      createdAt: booking.createdAt || booking.startDate || null,
    });
  }

  for (const item of equipment) {
    if (!item?._id) continue;
    events.push({
      _id: String(item._id),
      type: "equipment",
      activityType: "Equipment Submission",
      title: String(item.name || "Equipment Listing"),
      reference: String(item._id),
      status: String(item.status || EQUIPMENT_STATUSES.PENDING),
      createdAt: item.createdAt || item.updatedAt || null,
    });
  }

  for (const payment of payments) {
    if (!payment?._id) continue;
    events.push({
      _id: String(payment._id),
      type: "payment",
      activityType: "Payment Transaction",
      title: `Payment (${calculateNetPaymentAmount(payment)} ${String(
        payment.currency || DEFAULT_CURRENCY
      ).toUpperCase()})`,
      reference: String(payment.bookingId || payment._id),
      status: String(payment.status || "Pending"),
      createdAt: payment.paidAt || payment.createdAt || null,
    });
  }

  return events
    .sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, RECENT_ACTIVITY_TOTAL_LIMIT);
}

/**
 * Factory creating Admin platform-wide dashboard analytics service backed by MongoDB aggregation.
 */
export function createAdminAnalyticsService({
  usersCollectionGetter = getUsersCollection,
  equipmentCollectionGetter = getEquipmentCollection,
  bookingsCollectionGetter = getBookingsCollection,
  paymentsCollectionGetter = getPaymentsCollection,
  nowProvider = () => new Date(),
} = {}) {
  return {
    async getAdminAnalytics(rawQuery = {}) {
      const { period, monthsCount } = validateAnalyticsQuery(rawQuery);
      const { windowStart, currentMonthStart, nextMonthStart, months } =
        getAnalyticsMonthWindow(monthsCount, nowProvider());

      const [
        usersCollection,
        equipmentCollection,
        bookingsCollection,
        paymentsCollection,
      ] = await Promise.all([
        usersCollectionGetter(),
        equipmentCollectionGetter(),
        bookingsCollectionGetter(),
        paymentsCollectionGetter(),
      ]);

      const activeEquipmentFilter = { isDeleted: { $ne: true } };

      const [
        totalUsers,
        equipmentApprovalGroups,
        bookingFacetDocs,
        paymentFacetDocs,
        recentBookings,
        recentEquipment,
        recentPayments,
      ] = await Promise.all([
        usersCollection.countDocuments({ isDeleted: { $ne: true } }),
        equipmentCollection
          .aggregate([
            { $match: activeEquipmentFilter },
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
        bookingsCollection
          .aggregate([
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
                    },
                  },
                ],
                currentMonth: [
                  {
                    $match: {
                      createdAt: {
                        $gte: currentMonthStart,
                        $lt: nextMonthStart,
                      },
                    },
                  },
                  {
                    $group: {
                      _id: null,
                      count: { $sum: 1 },
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
                      bookings: { $sum: 1 },
                    },
                  },
                  { $sort: { _id: 1 } },
                ],
              },
            },
          ])
          .toArray(),
        paymentsCollection
          .aggregate([
            ...buildAuthoritativePaidPaymentStages(),
            {
              $facet: {
                allTime: [
                  {
                    $group: {
                      _id: null,
                      totalRevenue: { $sum: "$netAmount" },
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
                      revenue: { $sum: "$netAmount" },
                    },
                  },
                  { $sort: { _id: 1 } },
                ],
              },
            },
          ])
          .toArray(),
        bookingsCollection
          .find(
            {},
            {
              projection: {
                _id: 1,
                bookingStatus: 1,
                startDate: 1,
                createdAt: 1,
              },
            }
          )
          .sort({ createdAt: -1, _id: -1 })
          .limit(RECENT_ACTIVITY_SOURCE_LIMIT)
          .toArray(),
        equipmentCollection
          .find(activeEquipmentFilter, {
            projection: {
              _id: 1,
              name: 1,
              status: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          })
          .sort({ createdAt: -1, _id: -1 })
          .limit(RECENT_ACTIVITY_SOURCE_LIMIT)
          .toArray(),
        paymentsCollection
          .find(
            {},
            {
              projection: {
                _id: 1,
                bookingId: 1,
                amount: 1,
                refundedAmount: 1,
                currency: 1,
                status: 1,
                paidAt: 1,
                createdAt: 1,
              },
            }
          )
          .sort({ createdAt: -1, _id: -1 })
          .limit(RECENT_ACTIVITY_SOURCE_LIMIT)
          .toArray(),
      ]);

      const approvalMap = new Map();
      let totalEquipment = 0;
      for (const row of equipmentApprovalGroups) {
        const count = Math.max(0, Math.floor(Number(row?.count || 0)));
        totalEquipment += count;
        if (row?._id) {
          approvalMap.set(String(row._id), count);
        }
      }

      const equipmentApprovalData = CANONICAL_APPROVAL_STATUSES.map((status) => ({
        status,
        count: approvalMap.get(status) ?? 0,
      }));
      const pendingApprovals = approvalMap.get(EQUIPMENT_STATUSES.PENDING) ?? 0;

      const bookingFacet = bookingFacetDocs?.[0] || {};
      const bookingTotals = bookingFacet.totals?.[0] || {};
      const currentMonthBookings = bookingFacet.currentMonth?.[0] || {};
      const bookingMonthMap = new Map(
        (bookingFacet.monthlySeries || []).map((row) => [
          String(row._id),
          Math.max(0, Math.floor(Number(row.bookings || 0))),
        ])
      );

      const paymentFacet = paymentFacetDocs?.[0] || {};
      const paymentTotals = paymentFacet.allTime?.[0] || {};
      const revenueMonthMap = new Map(
        (paymentFacet.monthlySeries || []).map((row) => [
          String(row._id),
          roundCurrency(Math.max(0, Number(row.revenue || 0))),
        ])
      );

      const monthlyBookingData = zeroFillMonthlySeries(
        months,
        bookingMonthMap,
        (slot, bookingsCount) => ({
          month: slot.month,
          label: slot.label,
          yearMonth: slot.yearMonth,
          bookings: Math.max(0, Math.floor(Number(bookingsCount || 0))),
        })
      );

      const monthlyRevenueData = zeroFillMonthlySeries(
        months,
        revenueMonthMap,
        (slot, revenueAmount) => ({
          month: slot.month,
          label: slot.label,
          yearMonth: slot.yearMonth,
          revenue: roundCurrency(Math.max(0, Number(revenueAmount || 0))),
        })
      );

      return {
        period,
        currency: DEFAULT_CURRENCY,
        totalUsers: Math.max(0, Math.floor(Number(totalUsers || 0))),
        totalEquipment,
        totalBookings: Math.max(
          0,
          Math.floor(Number(bookingTotals.totalBookings || 0))
        ),
        pendingApprovals,
        completedRentals: Math.max(
          0,
          Math.floor(Number(bookingTotals.completedRentals || 0))
        ),
        totalRevenue: roundCurrency(
          Math.max(0, Number(paymentTotals.totalRevenue || 0))
        ),
        monthlyBookings: Math.max(
          0,
          Math.floor(Number(currentMonthBookings.count || 0))
        ),
        monthlyBookingData,
        monthlyRevenueData,
        equipmentApprovalData,
        recentActivity: normalizeRecentActivityItems({
          bookings: recentBookings,
          equipment: recentEquipment,
          payments: recentPayments,
        }),
      };
    },
  };
}

export const adminAnalyticsService = createAdminAnalyticsService();
