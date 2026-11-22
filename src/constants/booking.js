export const BOOKING_STATUSES = Object.freeze({
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  ACTIVE: "Active",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
});

export const ALLOWED_BOOKING_STATUSES = Object.freeze(
  Object.values(BOOKING_STATUSES)
);

export const DEFAULT_BOOKING_STATUS = BOOKING_STATUSES.PENDING;

export const BOOKING_INTENT_STATUSES = Object.freeze({
  PENDING_PAYMENT: "PendingPayment",
  EXPIRED: "Expired",
  CONVERTED: "Converted",
  FAILED: "Failed",
});

export const ALLOWED_BOOKING_INTENT_STATUSES = Object.freeze(
  Object.values(BOOKING_INTENT_STATUSES)
);

export const DEFAULT_BOOKING_INTENT_STATUS =
  BOOKING_INTENT_STATUSES.PENDING_PAYMENT;

export const CONTACT_INQUIRY_TYPES = Object.freeze([
  "General Inquiry",
  "Equipment Rental",
  "Equipment Listing",
  "Payment Support",
  "Technical Support",
  "Other",
]);

export const CONTACT_MESSAGE_STATUSES = Object.freeze({
  NEW: "New",
  IN_PROGRESS: "In Progress",
  RESOLVED: "Resolved",
});

export const ALLOWED_CONTACT_MESSAGE_STATUSES = Object.freeze(
  Object.values(CONTACT_MESSAGE_STATUSES)
);

export const DEFAULT_CONTACT_MESSAGE_STATUS = CONTACT_MESSAGE_STATUSES.NEW;
