import { adminRentalService } from "../services/adminRental.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP handlers for Admin platform-wide rental monitoring endpoints.
 */
export function createAdminRentalController(service = adminRentalService) {
  return {
    listAllRentals: asyncHandler(async (req, res) => {
      const result = await service.listAdminRentals({
        query: req.query,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Rental records retrieved successfully",
        data: result.items,
        pagination: result.pagination,
      });
    }),

    getRentalDetails: asyncHandler(async (req, res) => {
      const item = await service.getAdminRentalDetails({
        rentalId: req.params.id,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Rental record retrieved successfully",
        data: item,
      });
    }),

    updateRentalNote: asyncHandler(async (req, res) => {
      const updated = await service.updateAdminRentalNote({
        rentalId: req.params.id,
        body: req.body,
        adminUser: req.user,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Rental governance note updated successfully",
        data: updated,
      });
    }),
  };
}

export const adminRentalController = createAdminRentalController();
