/**
 * Role definitions for GearNest users.
 * Compatible with Better Auth `users` records where public signups default to `Customer`
 * and elevated role assignments are strictly limited to Admin-authorized endpoints.
 */
export const USER_ROLES = Object.freeze({
  CUSTOMER: "Customer",
  OWNER: "Owner",
  ADMIN: "Admin",
});

export const ALLOWED_USER_ROLES = Object.freeze(Object.values(USER_ROLES));

export const DEFAULT_USER_ROLE = USER_ROLES.CUSTOMER;
