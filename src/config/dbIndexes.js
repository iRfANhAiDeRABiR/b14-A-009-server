import { COLLECTIONS } from "../models/collections.js";
import { ApiError } from "../utils/ApiError.js";
import { getDB } from "./db.js";
import { redactMongoUri } from "./env.js";

/**
 * Authoritative collection index definitions for GearNest.
 * `users` email uniqueness avoids `sparse` / incompatible partial filters so
 * Better Auth's MongoDB adapter reuses the exact equivalent index cleanly.
 */
export const COLLECTION_INDEX_SPECS = Object.freeze({
  [COLLECTIONS.USERS]: [
    {
      key: { email: 1 },
      options: { name: "users_email_unique", unique: true },
    },
    {
      key: { role: 1 },
      options: { name: "users_role_idx" },
    },
    {
      key: { id: 1 },
      options: { name: "users_better_auth_id_idx", sparse: true },
    },
  ],
  [COLLECTIONS.EQUIPMENT]: [
    {
      key: { ownerId: 1 },
      options: { name: "equipment_owner_idx" },
    },
    {
      key: { status: 1 },
      options: { name: "equipment_status_idx" },
    },
    {
      key: { category: 1 },
      options: { name: "equipment_category_idx" },
    },
    {
      key: { location: 1 },
      options: { name: "equipment_location_idx" },
    },
    {
      key: { rentalPrice: 1 },
      options: { name: "equipment_rental_price_idx" },
    },
    {
      key: { createdAt: -1 },
      options: { name: "equipment_created_at_desc_idx" },
    },
    {
      key: { rentalType: 1 },
      options: { name: "equipment_rental_type_idx" },
    },
    {
      key: { availableQuantity: 1 },
      options: { name: "equipment_available_quantity_idx" },
    },
    {
      key: { status: 1, createdAt: -1, _id: -1 },
      options: { name: "equipment_public_newest_idx" },
    },
    {
      key: { status: 1, category: 1, rentalType: 1, rentalPrice: 1, _id: 1 },
      options: { name: "equipment_public_filter_price_idx" },
    },
    {
      key: { status: 1, availableQuantity: 1, createdAt: -1, _id: -1 },
      options: { name: "equipment_public_availability_newest_idx" },
    },
    {
      key: { name: "text", category: "text", location: "text" },
      options: {
        name: "equipment_search_text_idx",
        weights: { name: 10, category: 5, location: 4 },
        default_language: "english",
      },
    },
  ],
  [COLLECTIONS.BOOKINGS]: [
    {
      key: { customerId: 1 },
      options: { name: "bookings_customer_idx" },
    },
    {
      key: { ownerId: 1 },
      options: { name: "bookings_owner_idx" },
    },
    {
      key: { equipmentId: 1 },
      options: { name: "bookings_equipment_idx" },
    },
    {
      key: { bookingStatus: 1 },
      options: { name: "bookings_status_idx" },
    },
    {
      key: { paymentStatus: 1 },
      options: { name: "bookings_payment_status_idx" },
    },
    {
      key: { createdAt: -1 },
      options: { name: "bookings_created_at_desc_idx" },
    },
    {
      key: { customerId: 1, createdAt: -1, _id: -1 },
      options: { name: "bookings_customer_created_idx" },
    },
    {
      key: { ownerId: 1, createdAt: -1, _id: -1 },
      options: { name: "bookings_owner_created_idx" },
    },
    {
      key: { startDate: 1, _id: -1 },
      options: { name: "bookings_start_date_idx" },
    },
    {
      key: { endDate: 1, _id: -1 },
      options: { name: "bookings_end_date_idx" },
    },
    {
      key: { equipmentId: 1, bookingStatus: 1, startDate: 1, endDate: 1 },
      options: { name: "bookings_availability_dates_idx" },
    },
    {
      key: { bookingIntentId: 1 },
      options: {
        name: "bookings_booking_intent_unique",
        unique: true,
        partialFilterExpression: { bookingIntentId: { $exists: true } },
      },
    },
  ],
  [COLLECTIONS.BOOKING_INTENTS]: [
    {
      key: { customerId: 1, createdAt: -1 },
      options: { name: "booking_intents_customer_idx" },
    },
    {
      key: { equipmentId: 1, status: 1, expiresAt: 1, startDate: 1, endDate: 1 },
      options: { name: "booking_intents_availability_dates_idx" },
    },
    {
      key: { expiresAt: 1 },
      options: { name: "booking_intents_expires_at_ttl_idx", expireAfterSeconds: 0 },
    },
    {
      key: { stripeCheckoutSessionId: 1 },
      options: {
        name: "booking_intents_stripe_session_unique",
        unique: true,
        partialFilterExpression: { stripeCheckoutSessionId: { $type: "string" } },
      },
    },
  ],
  [COLLECTIONS.FAVORITES]: [
    {
      key: { userId: 1, equipmentId: 1 },
      options: { name: "favorites_user_equipment_unique", unique: true },
    },
    {
      key: { userId: 1, createdAt: -1 },
      options: { name: "favorites_user_created_at_desc_idx" },
    },
  ],
  [COLLECTIONS.PAYMENTS]: [
    {
      key: { bookingId: 1 },
      options: { name: "payments_booking_idx" },
    },
    {
      key: { customerId: 1 },
      options: { name: "payments_customer_idx" },
    },
    {
      key: { ownerId: 1 },
      options: { name: "payments_owner_idx" },
    },
    {
      key: { status: 1 },
      options: { name: "payments_status_idx" },
    },
    {
      key: { stripeCheckoutSessionId: 1 },
      options: {
        name: "payments_stripe_checkout_session_unique",
        unique: true,
        // Partial string filter prevents E11000 if pending payments omit or clear session IDs.
        partialFilterExpression: { stripeCheckoutSessionId: { $type: "string" } },
      },
    },
    {
      key: { stripePaymentIntentId: 1 },
      options: {
        name: "payments_stripe_payment_intent_unique",
        unique: true,
        partialFilterExpression: { stripePaymentIntentId: { $type: "string" } },
      },
    },
  ],
  [COLLECTIONS.CONTACT_MESSAGES]: [
    {
      key: { createdAt: -1 },
      options: { name: "contact_messages_created_at_desc_idx" },
    },
    {
      key: { status: 1 },
      options: { name: "contact_messages_status_idx" },
    },
  ],
  [COLLECTIONS.STRIPE_WEBHOOK_EVENTS]: [
    {
      key: { stripeEventId: 1 },
      options: { name: "stripe_webhook_events_event_id_unique", unique: true },
    },
  ],
});

function isTextIndexSpec(key = {}) {
  return Object.values(key).some((direction) => direction === "text");
}

function isEquivalentIndex(existingIndex, spec) {
  if (!existingIndex || !spec) return false;

  if (isTextIndexSpec(spec.key)) {
    if (existingIndex.key?._fts !== "text") return false;
    const desiredFields = Object.keys(spec.key).sort();
    const existingFields = Object.keys(existingIndex.weights || {}).sort();
    return JSON.stringify(desiredFields) === JSON.stringify(existingFields);
  }

  const sameKeys =
    JSON.stringify(existingIndex.key || {}) === JSON.stringify(spec.key || {});
  if (!sameKeys) return false;

  const sameUnique = Boolean(existingIndex.unique) === Boolean(spec.options?.unique);
  const sameSparse = Boolean(existingIndex.sparse) === Boolean(spec.options?.sparse);
  const sameExpireAfterSeconds =
    (existingIndex.expireAfterSeconds ?? null) ===
    (spec.options?.expireAfterSeconds ?? null);
  const samePartial =
    JSON.stringify(existingIndex.partialFilterExpression ?? null) ===
    JSON.stringify(spec.options?.partialFilterExpression ?? null);

  return sameUnique && sameSparse && sameExpireAfterSeconds && samePartial;
}

async function listCollectionNames(db) {
  const listed = await db.listCollections({}, { nameOnly: true }).toArray();
  return new Set(listed.map((item) => item.name));
}

async function safeListIndexes(collection) {
  try {
    return await collection.listIndexes().toArray();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") {
      return [];
    }
    throw error;
  }
}

/**
 * Ensures all required GearNest collections and indexes exist idempotently.
 * Inspects existing indexes first and never drops collections or existing indexes.
 */
export async function ensureDatabaseCollectionsAndIndexes(db = getDB()) {
  let collectionsCreated = 0;
  let indexesCreated = 0;
  let indexesSkipped = 0;

  try {
    const existingCollections = await listCollectionNames(db);

    for (const collectionName of Object.values(COLLECTIONS)) {
      if (!existingCollections.has(collectionName)) {
        try {
          await db.createCollection(collectionName);
          collectionsCreated += 1;
        } catch (error) {
          if (error?.code !== 48 && error?.codeName !== "NamespaceExists") {
            throw error;
          }
        }
      }
    }

    for (const [collectionName, specs] of Object.entries(COLLECTION_INDEX_SPECS)) {
      const collection = db.collection(collectionName);
      const existingIndexes = await safeListIndexes(collection);

      for (const spec of specs) {
        const alreadyPresent = existingIndexes.some((existing) =>
          isEquivalentIndex(existing, spec)
        );

        if (alreadyPresent) {
          indexesSkipped += 1;
          continue;
        }

        try {
          await collection.createIndex(spec.key, spec.options);
          indexesCreated += 1;
        } catch (error) {
          if (
            error?.code === 68 ||
            error?.code === 85 ||
            error?.code === 86 ||
            error?.codeName === "IndexAlreadyExists"
          ) {
            const refreshed = await safeListIndexes(collection);
            if (refreshed.some((existing) => isEquivalentIndex(existing, spec))) {
              indexesSkipped += 1;
              continue;
            }
          }
          throw error;
        }
      }
    }

    return {
      collectionsChecked: Object.values(COLLECTIONS).length,
      collectionsCreated,
      indexesCreated,
      indexesSkipped,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    const safeMsg = redactMongoUri(
      error?.message || "Failed to initialize MongoDB collections and indexes."
    );
    throw new ApiError(`Database index initialization failed: ${safeMsg}`, 500, {
      code: "DB_INDEX_INIT_FAILED",
      isOperational: true,
    });
  }
}
