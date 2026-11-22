import { getDB } from "../config/db.js";

/**
 * Canonical MongoDB collection names for GearNest.
 * Note: Better Auth uses pluralized core collections (`usePlural: true`)
 * so Better Auth reads and writes the shared `users` collection directly.
 */
export const COLLECTIONS = Object.freeze({
  USERS: "users",
  EQUIPMENT: "equipment",
  BOOKINGS: "bookings",
  FAVORITES: "favorites",
  PAYMENTS: "payments",
  CONTACT_MESSAGES: "contactMessages",
  STRIPE_WEBHOOK_EVENTS: "stripeWebhookEvents",
});

export function getUsersCollection(db = getDB()) {
  return db.collection(COLLECTIONS.USERS);
}

export function getEquipmentCollection(db = getDB()) {
  return db.collection(COLLECTIONS.EQUIPMENT);
}

export function getBookingsCollection(db = getDB()) {
  return db.collection(COLLECTIONS.BOOKINGS);
}

export function getFavoritesCollection(db = getDB()) {
  return db.collection(COLLECTIONS.FAVORITES);
}

export function getPaymentsCollection(db = getDB()) {
  return db.collection(COLLECTIONS.PAYMENTS);
}

export function getContactMessagesCollection(db = getDB()) {
  return db.collection(COLLECTIONS.CONTACT_MESSAGES);
}

export function getStripeWebhookEventsCollection(db = getDB()) {
  return db.collection(COLLECTIONS.STRIPE_WEBHOOK_EVENTS);
}
