import { ownerRentalService } from "../services/ownerRental.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP handlers for authenticated Owner rental endpoints.
 */
export function createOwnerRentalController(service = ownerRentalService) {
  return {
    listMyRentals: asyncHandler(async (req, res) => {
      const result = await service.listOwnerRentals({
        ownerId: req.user.id,
        query: req.query,
      });

      return res.status(200).json({
        success: true,
        message: "Rental records retrieved successfully",
        data: result.items,
        pagination: result.pagination,
        ...(result.summary ? { summary: result.summary } : {}),
      });
    }),

    getMyRentalDetails: asyncHandler(async (req, res) => {
      const item = await service.getOwnerRentalDetails({
        ownerId: req.user.id,
        rentalId: req.params.id,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Rental record retrieved successfully",
        data: item,
      });
    }),
  };
}

export const ownerRentalController = createOwnerRentalController();
