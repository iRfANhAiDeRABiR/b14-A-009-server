import { EQUIPMENT_STATUSES } from "../constants/equipment.js";
import {
  COLLECTIONS,
  getEquipmentCollection,
  getFavoritesCollection,
} from "../models/collections.js";
import {
  buildFavoriteDocument,
  SAFE_FAVORITE_EQUIPMENT_PROJECTION,
  sanitizeFavoriteListItem,
} from "../models/favorite.model.js";
import { ApiError } from "../utils/ApiError.js";
import {
  validateAddFavoritePayload,
  validateFavoriteEquipmentId,
  validateFavoriteListQuery,
} from "../validators/favorite.validator.js";
import { normalizeUserIdentifier } from "../validators/validationHelpers.js";

/**
 * Factory creating MongoDB-backed customer favorites business operations.
 * Every operation binds strictly to the authenticated `userId` (`req.user.id`).
 */
export function createFavoriteService({
  favoritesCollectionGetter = getFavoritesCollection,
  equipmentCollectionGetter = getEquipmentCollection,
} = {}) {
  return {
    async addFavorite({ userId, payload }) {
      const normalizedUserId = normalizeUserIdentifier(userId, "userId");
      const { equipmentId: equipmentObjectId } = validateAddFavoritePayload(payload);

      const [equipmentCollection, favoritesCollection] = await Promise.all([
        equipmentCollectionGetter(),
        favoritesCollectionGetter(),
      ]);

      const equipment = await equipmentCollection.findOne(
        { _id: equipmentObjectId },
        { projection: { _id: 1, status: 1, isDeleted: 1 } }
      );

      if (!equipment || equipment.isDeleted === true) {
        throw new ApiError("Equipment not found", 404, { code: "NOT_FOUND" });
      }

      if (equipment.status !== EQUIPMENT_STATUSES.APPROVED) {
        throw new ApiError("Only approved equipment can be added to favorites", 400, {
          code: "EQUIPMENT_NOT_APPROVED",
        });
      }

      const existing = await favoritesCollection.findOne(
        {
          userId: normalizedUserId,
          equipmentId: equipmentObjectId,
        },
        { projection: { _id: 1 } }
      );

      if (existing) {
        return {
          created: false,
          message: "Equipment is already in favorites",
          data: {
            equipmentId: String(equipmentObjectId),
            isFavorite: true,
            alreadyExists: true,
          },
        };
      }

      const favoriteDoc = buildFavoriteDocument({
        userId: normalizedUserId,
        equipmentId: equipmentObjectId,
      });

      try {
        await favoritesCollection.insertOne(favoriteDoc);
      } catch (error) {
        // Unique index { userId: 1, equipmentId: 1 } rejects concurrent duplicate inserts
        if (error?.code === 11000) {
          return {
            created: false,
            message: "Equipment is already in favorites",
            data: {
              equipmentId: String(equipmentObjectId),
              isFavorite: true,
              alreadyExists: true,
            },
          };
        }
        throw error;
      }

      return {
        created: true,
        message: "Equipment added to favorites successfully",
        data: {
          equipmentId: String(equipmentObjectId),
          isFavorite: true,
        },
      };
    },

    async getMyFavorites({ userId, query = {} }) {
      const normalizedUserId = normalizeUserIdentifier(userId, "userId");
      const paginationOptions = validateFavoriteListQuery(query);
      const favoritesCollection = await favoritesCollectionGetter();

      const pipeline = [
        { $match: { userId: normalizedUserId } },
        { $sort: { createdAt: -1, _id: -1 } },
      ];

      if (paginationOptions.paginate) {
        pipeline.push({ $skip: paginationOptions.skip }, { $limit: paginationOptions.limit });
      }

      pipeline.push(
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
          $project: {
            _id: 1,
            equipmentId: 1,
            createdAt: 1,
            equipmentDoc: Object.fromEntries(
              Object.keys(SAFE_FAVORITE_EQUIPMENT_PROJECTION).map((field) => [
                field,
                `$equipmentDoc.${field}`,
              ])
            ),
          },
        }
      );

      if (paginationOptions.paginate) {
        const [totalItems, docs] = await Promise.all([
          favoritesCollection.countDocuments({ userId: normalizedUserId }),
          favoritesCollection.aggregate(pipeline).toArray(),
        ]);

        return {
          items: docs.map(sanitizeFavoriteListItem).filter(Boolean),
          pagination: {
            currentPage: paginationOptions.page,
            limit: paginationOptions.limit,
            totalItems,
            totalPages:
              totalItems === 0 ? 0 : Math.ceil(totalItems / paginationOptions.limit),
          },
        };
      }

      const docs = await favoritesCollection.aggregate(pipeline).toArray();
      return {
        items: docs.map(sanitizeFavoriteListItem).filter(Boolean),
        pagination: null,
      };
    },

    async getFavoriteStatus({ userId, equipmentId }) {
      const normalizedUserId = normalizeUserIdentifier(userId, "userId");
      const equipmentObjectId = validateFavoriteEquipmentId(equipmentId);
      const favoritesCollection = await favoritesCollectionGetter();

      const existing = await favoritesCollection.findOne(
        {
          userId: normalizedUserId,
          equipmentId: equipmentObjectId,
        },
        { projection: { _id: 1 } }
      );

      return {
        equipmentId: String(equipmentObjectId),
        isFavorite: Boolean(existing),
      };
    },

    async removeFavorite({ userId, equipmentId }) {
      const normalizedUserId = normalizeUserIdentifier(userId, "userId");
      const equipmentObjectId = validateFavoriteEquipmentId(equipmentId);
      const favoritesCollection = await favoritesCollectionGetter();

      const result = await favoritesCollection.deleteOne({
        userId: normalizedUserId,
        equipmentId: equipmentObjectId,
      });

      if (!result || result.deletedCount === 0) {
        throw new ApiError("Favorite not found", 404, { code: "NOT_FOUND" });
      }

      return {
        equipmentId: String(equipmentObjectId),
        isFavorite: false,
      };
    },
  };
}

export const favoriteService = createFavoriteService();
