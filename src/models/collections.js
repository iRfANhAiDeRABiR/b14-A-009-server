import { getDB } from "../config/db.js";

/**
 * Canonical MongoDB collection names for GearNest.
 * Note: Better Auth uses pluralized core collections (`usePlural: true`)
 * so Better Auth reads and writes the shared `users` collection directly.
 */
export const COLLECTIONS = Object.freeze({
  USERS: "users",
  SESSIONS: "sessions",
  EQUIPMENT: "equipment",
  BOOKINGS: "bookings",
  BOOKING_INTENTS: "bookingIntents",
  FAVORITES: "favorites",
  PAYMENTS: "payments",
  CONTACT_MESSAGES: "contactMessages",
  STRIPE_WEBHOOK_EVENTS: "stripeWebhookEvents",
  AUDIT_LOGS: "auditLogs",
});

export function getUsersCollection(db = getDB()) {
  return db.collection(COLLECTIONS.USERS);
}

export function getSessionsCollection(db = getDB()) {
  return db.collection(COLLECTIONS.SESSIONS);
}

export function getEquipmentCollection(db = getDB()) {
  return db.collection(COLLECTIONS.EQUIPMENT);
}

export function getBookingsCollection(db = getDB()) {
  return db.collection(COLLECTIONS.BOOKINGS);
}

export function getBookingIntentsCollection(db = getDB()) {
  return db.collection(COLLECTIONS.BOOKING_INTENTS);
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

export function getAuditLogsCollection(db = getDB()) {
  return db.collection(COLLECTIONS.AUDIT_LOGS);
}
