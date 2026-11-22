import { favoriteService } from "../services/favorite.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP request handlers for customer favorites endpoints.
 * All handlers bind exclusively to authenticated `req.user.id`.
 */
export function createFavoriteController(service = favoriteService) {
  return {
    add: asyncHandler(async (req, res) => {
      const result = await service.addFavorite({
        userId: req.user.id,
        payload: req.body,
      });

      return sendSuccess(res, {
        statusCode: result.created ? 201 : 200,
        message: result.message,
        data: result.data,
      });
    }),

    listMine: asyncHandler(async (req, res) => {
      const result = await service.getMyFavorites({
        userId: req.user.id,
        query: req.query,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Favorites retrieved successfully",
        data: result.items,
        pagination: result.pagination,
      });
    }),

    getStatus: asyncHandler(async (req, res) => {
      const status = await service.getFavoriteStatus({
        userId: req.user.id,
        equipmentId: req.params.equipmentId,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Favorite status retrieved successfully",
        data: status,
      });
    }),

    remove: asyncHandler(async (req, res) => {
      const removed = await service.removeFavorite({
        userId: req.user.id,
        equipmentId: req.params.equipmentId,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "Equipment removed from favorites successfully",
        data: removed,
      });
    }),
  };
}

export const favoriteController = createFavoriteController();
