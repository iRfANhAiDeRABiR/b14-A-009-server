import { DEFAULT_EQUIPMENT_STATUS } from "../constants/equipment.js";
import { getEquipmentCollection } from "./collections.js";
import { validateEquipmentInput } from "../validators/equipmentValidator.js";

/**
 * @typedef {Object} EquipmentDocument
 * @property {import("mongodb").ObjectId} [_id]
 * @property {string} name
 * @property {string} description
 * @property {"Construction Equipment"|"Photography Equipment"|"Vehicles & Transportation"|"Agriculture Equipment"|"Electronics"|"Event Equipment"} category
 * @property {string} location
 * @property {number} rentalPrice
 * @property {"Daily"|"Weekly"|"Monthly"} rentalType
 * @property {number} availableQuantity
 * @property {string} condition
 * @property {string} brand
 * @property {string} model
 * @property {string} image
 * @property {string} rentalTerms
 * @property {import("mongodb").ObjectId | string} ownerId
 * @property {"Pending"|"Approved"|"Rejected"} status
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export const SAFE_EQUIPMENT_OWNER_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  image: 1,
});

export { getEquipmentCollection };

/**
 * Validates and builds a new equipment document defaulting approval status to `Pending`.
 */
export function buildEquipmentDocument(payload = {}) {
  const clean = validateEquipmentInput(payload, { requireOwnerId: true });
  const now = new Date();
  return {
    ...clean,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Normalizes equipment document fields cleanly for public and owner responses,
 * attaching optional sanitized owner summary without leaking private user data.
 */
export function sanitizeEquipmentRecord(doc, ownerDoc = null) {
  if (!doc || typeof doc !== "object") return null;

  const base = {
    _id: doc._id ? String(doc._id) : null,
    name: doc.name || "",
    description: doc.description || "",
    category: doc.category || "",
    location: doc.location || "",
    rentalPrice: Number(doc.rentalPrice) || 0,
    rentalType: doc.rentalType || "Daily",
    availableQuantity: Number.isInteger(doc.availableQuantity)
      ? doc.availableQuantity
      : Number(doc.availableQuantity) || 0,
    condition: doc.condition || "",
    brand: doc.brand || "",
    model: doc.model || "",
    image: doc.image || "",
    rentalTerms: doc.rentalTerms || "",
    ownerId: doc.ownerId !== undefined && doc.ownerId !== null ? String(doc.ownerId) : "",
    status: doc.status || DEFAULT_EQUIPMENT_STATUS,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };

  if (ownerDoc && typeof ownerDoc === "object") {
    base.owner = {
      id: ownerDoc.id ? String(ownerDoc.id) : ownerDoc._id ? String(ownerDoc._id) : "",
      name: ownerDoc.name || "GearNest Owner",
      image: ownerDoc.image || null,
    };
  }

  return base;
}
