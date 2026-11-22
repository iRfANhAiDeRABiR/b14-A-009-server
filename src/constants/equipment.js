export const EQUIPMENT_CATEGORIES = Object.freeze([
  "Construction Equipment",
  "Photography Equipment",
  "Vehicles & Transportation",
  "Agriculture Equipment",
  "Electronics",
  "Event Equipment",
]);

export const RENTAL_TYPES = Object.freeze(["Daily", "Weekly", "Monthly"]);

export const EQUIPMENT_STATUSES = Object.freeze({
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
});

export const ALLOWED_EQUIPMENT_STATUSES = Object.freeze(
  Object.values(EQUIPMENT_STATUSES)
);

export const DEFAULT_EQUIPMENT_STATUS = EQUIPMENT_STATUSES.PENDING;

export const EQUIPMENT_CONDITIONS = Object.freeze([
  "Like New",
  "Excellent",
  "Good",
  "Fair",
  "Refurbished",
]);

export const EQUIPMENT_LIMITS = Object.freeze({
  nameMin: 3,
  nameMax: 100,
  descriptionMin: 20,
  descriptionMax: 1500,
  locationMin: 2,
  locationMax: 120,
  brandMax: 80,
  modelMax: 80,
  termsMin: 10,
  termsMax: 1500,
});
