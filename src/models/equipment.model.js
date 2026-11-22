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
