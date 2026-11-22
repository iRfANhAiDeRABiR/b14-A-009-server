import {
  buildContactMessageDocument,
  getContactMessagesCollection,
} from "../models/contactMessage.model.js";
import { ApiError } from "../utils/ApiError.js";

const RESTRICTED_CONTACT_KEYS = new Set([
  "_id",
  "status",
  "createdAt",
  "updatedAt",
]);

const UNSAFE_PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertCleanContactPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("Invalid contact message payload.", 400, {
      code: "VALIDATION_ERROR",
    });
  }

  for (const key of Object.keys(payload)) {
    if (key.startsWith("$") || key.includes(".") || UNSAFE_PROTOTYPE_KEYS.has(key)) {
      throw new ApiError("Invalid characters detected in request payload.", 400, {
        code: "INVALID_INPUT",
      });
    }
    if (RESTRICTED_CONTACT_KEYS.has(key)) {
      throw new ApiError(
        `Server-controlled field "${key}" cannot be supplied by clients.`,
        400,
        { code: "RESTRICTED_FIELD" }
      );
    }
  }
}

/**
 * Factory creating public contact message submission service backed by `contactMessages`.
 */
export function createContactService({
  contactMessagesCollectionGetter = getContactMessagesCollection,
  nowProvider = () => new Date(),
} = {}) {
  return {
    async submitMessage(payload = {}) {
      assertCleanContactPayload(payload);

      const baseDoc = buildContactMessageDocument(payload);
      const now = nowProvider();
      const docToInsert = {
        ...baseDoc,
        createdAt: now,
        updatedAt: now,
      };

      const contactMessages = await contactMessagesCollectionGetter();
      const insertResult = await contactMessages.insertOne(docToInsert);

      if (insertResult?.acknowledged === false || !insertResult?.insertedId) {
        throw new ApiError("Unable to store your contact message right now.", 500, {
          code: "CONTACT_PERSISTENCE_FAILED",
          isOperational: true,
        });
      }

      return {
        _id: String(insertResult.insertedId),
        inquiryType: docToInsert.inquiryType,
        status: docToInsert.status,
        createdAt: docToInsert.createdAt,
      };
    },
  };
}

export const contactService = createContactService();
