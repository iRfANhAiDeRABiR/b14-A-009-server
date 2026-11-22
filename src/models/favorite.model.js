import { getFavoritesCollection } from "./collections.js";
import { normalizeUserIdentifier, toObjectId } from "../validators/validationHelpers.js";

/**
 * @typedef {Object} FavoriteDocument
 * @property {import("mongodb").ObjectId} [_id]
 * @property {import("mongodb").ObjectId | string} userId
 * @property {import("mongodb").ObjectId} equipmentId
 * @property {Date} createdAt
 */

export { getFavoritesCollection };

/**
 * Builds a validated favorite document backed by a unique `{ userId, equipmentId }` index.
 */
export function buildFavoriteDocument({ userId, equipmentId }) {
  return {
    userId: normalizeUserIdentifier(userId, "userId"),
    equipmentId: toObjectId(equipmentId, "equipmentId"),
    createdAt: new Date(),
  };
}
