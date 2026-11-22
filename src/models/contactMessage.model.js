import { getContactMessagesCollection } from "./collections.js";
import { validateContactMessageInput } from "../validators/bookingValidator.js";

/**
 * @typedef {Object} ContactMessageDocument
 * @property {import("mongodb").ObjectId} [_id]
 * @property {string} name
 * @property {string} email
 * @property {"General Inquiry"|"Equipment Rental"|"Equipment Listing"|"Payment Support"|"Technical Support"|"Other"} inquiryType
 * @property {string} subject
 * @property {string} message
 * @property {"New"|"In Progress"|"Resolved"} status
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export { getContactMessagesCollection };

/**
 * Validates and builds a contact inquiry document defaulting status to `New`.
 */
export function buildContactMessageDocument(payload = {}) {
  const clean = validateContactMessageInput(payload);
  const now = new Date();
  return {
    ...clean,
    createdAt: now,
    updatedAt: now,
  };
}
