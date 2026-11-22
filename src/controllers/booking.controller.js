import { bookingService } from "../services/booking.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP request handlers for customer rental booking endpoints.
 * Customer identity always resolves from verified `req.user.id`.
 */
export function createBookingController(service = bookingService) {
  return {
    checkAvailability: asyncHandler(async (req, res) => {
      const availability = await service.checkAvailability({
        payload: req.body,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Availability checked successfully",
        data: availability,
      });
    }),

    createReservation: asyncHandler(async (req, res) => {
      const result = await service.createBookingReservation({
        customerId: req.user.id,
        payload: req.body,
      });

      return sendSuccess(res, {
        statusCode: result.created ? 201 : 200,
        message: "Rental reservation created successfully. Continue to payment.",
        data: result.data,
      });
    }),

    listMyBookings: asyncHandler(async (req, res) => {
      const result = await service.listCustomerBookings({
        customerId: req.user.id,
        query: req.query,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Bookings retrieved successfully",
        data: result.items,
        pagination: result.pagination,
      });
    }),

    getMyBookingDetails: asyncHandler(async (req, res) => {
      const booking = await service.getCustomerBookingDetails({
        customerId: req.user.id,
        bookingId: req.params.id,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Booking details retrieved successfully",
        data: booking,
      });
    }),
  };
}

export const bookingController = createBookingController();
