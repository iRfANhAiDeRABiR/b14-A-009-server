import { EQUIPMENT_STATUSES } from "../constants/equipment.js";
import { normalizeUserIdentifier, toObjectId } from "../validators/validationHelpers.js";
import { getFavoritesCollection } from "./collections.js";

/**
 * @typedef {Object} FavoriteDocument
 * @property {import("mongodb").ObjectId} [_id]
 * @property {import("mongodb").ObjectId | string} userId
 * @property {import("mongodb").ObjectId} equipmentId
 * @property {Date} createdAt
 */

export const SAFE_FAVORITE_EQUIPMENT_PROJECTION = Object.freeze({
  _id: 1,
  name: 1,
  image: 1,
  category: 1,
  rentalPrice: 1,
  rentalType: 1,
  location: 1,
  availableQuantity: 1,
  status: 1,
});

export { getFavoritesCollection };

/**
 * Builds a validated favorite relationship document backed by a unique `{ userId, equipmentId }` index.
 * Equipment snapshots are never duplicated inside the favorites collection.
 */
export function buildFavoriteDocument({ userId, equipmentId }) {
  return {
    userId: normalizeUserIdentifier(userId, "userId"),
    equipmentId: toObjectId(equipmentId, "equipmentId"),
    createdAt: new Date(),
  };
}

/**
 * Formats an aggregated favorite + looked-up equipment record safely across all listing states:
 * - Approved & in stock: full display fields + Available status
 * - Approved & out of stock: full display fields + Unavailable status
 * - Pending / Rejected: minimal hidden placeholder so private details are never leaked
 * - Deleted equipment: safe removed placeholder so customer can delete the stale favorite
 */
export function sanitizeFavoriteListItem(doc) {
  if (!doc || typeof doc !== "object") return null;

  const base = {
    _id: doc._id ? String(doc._id) : null,
    equipmentId: doc.equipmentId ? String(doc.equipmentId) : "",
    createdAt: doc.createdAt || null,
  };

  const eq = doc.equipmentDoc;
  if (!eq || typeof eq !== "object") {
    return {
      ...base,
      name: "Equipment No Longer Listed",
      image: "",
      category: "",
      rentalPrice: null,
      rentalType: "",
      location: "",
      availableQuantity: 0,
      availabilityStatus: "Unavailable (Removed)",
      isAvailable: false,
      isDeleted: true,
      equipmentDeleted: true,
    };
  }

  if (eq.status !== EQUIPMENT_STATUSES.APPROVED) {
    return {
      ...base,
      name: "Unavailable Listing",
      image: "",
      category: "",
      rentalPrice: null,
      rentalType: "",
      location: "",
      availableQuantity: 0,
      status: "Unavailable",
      availabilityStatus: "Unavailable",
      isAvailable: false,
      isListingHidden: true,
      isDeleted: false,
    };
  }

  const parsedQty = Number(eq.availableQuantity);
  const availableQuantity = Number.isFinite(parsedQty) ? parsedQty : 0;
  const isAvailable = availableQuantity > 0;

  return {
    ...base,
    name: eq.name || "",
    image: eq.image || "",
    category: eq.category || "",
    rentalPrice: Number.isFinite(Number(eq.rentalPrice))
      ? Number(eq.rentalPrice)
      : 0,
    rentalType: eq.rentalType || "",
    location: eq.location || "",
    availableQuantity,
    status: EQUIPMENT_STATUSES.APPROVED,
    availabilityStatus: isAvailable ? "Available" : "Unavailable",
    isAvailable,
    isDeleted: false,
  };
}
