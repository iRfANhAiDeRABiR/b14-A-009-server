import { USER_ROLES } from "../constants/roles.js";
import { getSessionsCollection } from "../models/collections.js";
import {
  buildUserLookupFilter,
  getUsersCollection,
  resolveUserIdentifier,
  SAFE_USER_PROJECTION,
  sanitizeAdminUserProfile,
} from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import {
  validateAdminRoleUpdateBody,
  validateAdminTargetUserId,
  validateAdminUserListQuery,
  validateAdminUserProfileUpdateBody,
  validateAdminUserStatusBody,
} from "../validators/adminUser.validator.js";
import { recordAuditEventSafe } from "./auditLog.service.js";

const SORT_MAP = Object.freeze({
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  name_asc: { name: 1, _id: 1 },
  name_desc: { name: -1, _id: -1 },
});

function buildStatusFilter(status) {
  if (status === "Suspended") {
    return {
      $or: [{ suspended: true }, { status: "Suspended" }],
    };
  }
  if (status === "Banned") {
    return {
      $or: [{ banned: true }, { status: "Banned" }],
    };
  }
  if (status === "Active") {
    return {
      suspended: { $ne: true },
      banned: { $ne: true },
      disabled: { $ne: true },
      active: { $ne: false },
    };
  }
  return null;
}

/**
 * Factory creating Admin user governance service methods with injectable collection getters for tests.
 */
export function createAdminUserService({
  usersCollectionGetter = getUsersCollection,
  sessionsCollectionGetter = getSessionsCollection,
  auditLogger = recordAuditEventSafe,
  nowProvider = () => new Date(),
} = {}) {
  async function revokeUserSessionsSafely(userDoc, rawTargetId) {
    try {
      const sessions = await sessionsCollectionGetter();
      const candidates = [
        rawTargetId,
        resolveUserIdentifier(userDoc),
        userDoc?._id,
        userDoc?.id,
      ].filter(Boolean);
      if (candidates.length > 0) {
        await sessions.deleteMany({ userId: { $in: candidates } });
      }
    } catch {
      // Non-fatal in unit test suites that do not initialize MongoDB `sessions`.
    }
  }

  async function ensureAnotherActiveAdminExists(usersCollection, targetUserDoc) {
    if (targetUserDoc?.role !== USER_ROLES.ADMIN) return;
    const activeAdmins = await usersCollection.countDocuments({
      role: USER_ROLES.ADMIN,
      isDeleted: { $ne: true },
      banned: { $ne: true },
      suspended: { $ne: true },
      disabled: { $ne: true },
    });
    if (activeAdmins <= 1) {
      throw new ApiError(
        "Cannot restrict or remove the last active Administrator account.",
        400,
        { code: "LAST_ADMIN_PROTECTED" }
      );
    }
  }

  return {
    async listUsers(rawQuery = {}) {
      const { escapedSearch, role, status, sort, page, limit } =
        validateAdminUserListQuery(rawQuery);

      const filter = { isDeleted: { $ne: true } };
      if (role !== "all") {
        filter.role = role;
      }

      const statusPredicate = buildStatusFilter(status);
      if (statusPredicate && escapedSearch) {
        filter.$and = [
          statusPredicate,
          {
            $or: [
              { name: { $regex: escapedSearch, $options: "i" } },
              { email: { $regex: escapedSearch, $options: "i" } },
            ],
          },
        ];
      } else if (statusPredicate) {
        Object.assign(filter, statusPredicate);
      } else if (escapedSearch) {
        filter.$or = [
          { name: { $regex: escapedSearch, $options: "i" } },
          { email: { $regex: escapedSearch, $options: "i" } },
        ];
      }

      const sortSpec = SORT_MAP[sort] || SORT_MAP.newest;
      const skip = (page - 1) * limit;

      const usersCollection = await usersCollectionGetter();
      const [totalItems, docs] = await Promise.all([
        usersCollection.countDocuments(filter),
        usersCollection
          .find(filter, { projection: SAFE_USER_PROJECTION })
          .sort(sortSpec)
          .skip(skip)
          .limit(limit)
          .toArray(),
      ]);

      return {
        users: docs.map(sanitizeAdminUserProfile),
        pagination: {
          currentPage: page,
          limit,
          totalItems,
          totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / limit),
        },
      };
    },

    async getUserById(rawTargetUserId) {
      const targetUserId = validateAdminTargetUserId(rawTargetUserId);
      const usersCollection = await usersCollectionGetter();
      const user = await usersCollection.findOne(
        buildUserLookupFilter(targetUserId),
        { projection: SAFE_USER_PROJECTION }
      );

      if (!user || user.isDeleted === true) {
        throw new ApiError("User not found", 404, { code: "NOT_FOUND" });
      }

      return sanitizeAdminUserProfile(user);
    },

    async updateUserRole({ rawTargetUserId, body, adminUserId, adminUser = null }) {
      const targetUserId = validateAdminTargetUserId(rawTargetUserId);
      const nextRole = validateAdminRoleUpdateBody(body);

      const usersCollection = await usersCollectionGetter();
      const existingUser = await usersCollection.findOne(
        buildUserLookupFilter(targetUserId),
        { projection: SAFE_USER_PROJECTION }
      );

      if (!existingUser || existingUser.isDeleted === true) {
        throw new ApiError("User not found", 404, { code: "NOT_FOUND" });
      }

      const resolvedTargetId = resolveUserIdentifier(existingUser);
      const actorId = adminUser?.id || adminUserId;
      if (resolvedTargetId && String(resolvedTargetId) === String(actorId)) {
        throw new ApiError(
          "Administrators cannot modify their own role through this endpoint.",
          400,
          { code: "SELF_ROLE_UPDATE_FORBIDDEN" }
        );
      }

      if (existingUser.role === nextRole) {
        return {
          user: sanitizeAdminUserProfile(existingUser),
          unchanged: true,
        };
      }

      const now = nowProvider();
      const updateResult = await usersCollection.findOneAndUpdate(
        buildUserLookupFilter(targetUserId),
        {
          $set: {
            role: nextRole,
            updatedAt: now,
          },
        },
        {
          returnDocument: "after",
          projection: SAFE_USER_PROJECTION,
        }
      );

      const updatedUser =
        updateResult && typeof updateResult === "object" && "value" in updateResult
          ? updateResult.value
          : updateResult;

      if (!updatedUser) {
        throw new ApiError("User not found", 404, { code: "NOT_FOUND" });
      }

      await auditLogger({
        action: "USER_ROLE_UPDATED",
        category: "user",
        severity: nextRole === USER_ROLES.ADMIN ? "warning" : "info",
        summary: `Changed role for ${updatedUser.email || updatedUser.name} from ${existingUser.role} to ${nextRole}`,
        actor: adminUser || { id: actorId },
        target: {
          type: "user",
          id: resolvedTargetId || targetUserId,
          label: updatedUser.email || updatedUser.name,
        },
        metadata: {
          previousRole: existingUser.role,
          nextRole,
        },
      });

      return {
        user: sanitizeAdminUserProfile(updatedUser),
        unchanged: false,
      };
    },

    async updateUserStatus({ rawTargetUserId, body, adminUser }) {
      const targetUserId = validateAdminTargetUserId(rawTargetUserId);
      const { status, reason } = validateAdminUserStatusBody(body);
      const now = nowProvider();

      const usersCollection = await usersCollectionGetter();
      const existingUser = await usersCollection.findOne(
        buildUserLookupFilter(targetUserId),
        { projection: SAFE_USER_PROJECTION }
      );

      if (!existingUser || existingUser.isDeleted === true) {
        throw new ApiError("User not found", 404, { code: "NOT_FOUND" });
      }

      const resolvedTargetId = resolveUserIdentifier(existingUser);
      if (resolvedTargetId && String(resolvedTargetId) === String(adminUser?.id)) {
        throw new ApiError(
          "Administrators cannot suspend or ban their own account.",
          400,
          { code: "SELF_STATUS_UPDATE_FORBIDDEN" }
        );
      }

      if (status !== "Active") {
        await ensureAnotherActiveAdminExists(usersCollection, existingUser);
      }

      const setFields = {
        suspended: status === "Suspended",
        banned: status === "Banned",
        disabled: status !== "Active",
        active: status === "Active",
        status,
        suspensionReason: status === "Active" ? "" : reason,
        statusUpdatedAt: now,
        statusUpdatedBy: adminUser?.id || "",
        updatedAt: now,
      };

      const updateResult = await usersCollection.findOneAndUpdate(
        buildUserLookupFilter(targetUserId),
        { $set: setFields },
        {
          returnDocument: "after",
          projection: SAFE_USER_PROJECTION,
        }
      );

      const updatedUser =
        updateResult && typeof updateResult === "object" && "value" in updateResult
          ? updateResult.value
          : updateResult;

      if (!updatedUser) {
        throw new ApiError("User not found", 404, { code: "NOT_FOUND" });
      }

      if (status !== "Active") {
        await revokeUserSessionsSafely(existingUser, targetUserId);
      }

      const actionName =
        status === "Banned"
          ? "USER_BANNED"
          : status === "Suspended"
            ? "USER_SUSPENDED"
            : "USER_REACTIVATED";

      await auditLogger({
        action: actionName,
        category: "user",
        severity: status === "Active" ? "info" : "warning",
        summary:
          status === "Active"
            ? `Reactivated user account ${updatedUser.email || updatedUser.name}`
            : `Marked user ${updatedUser.email || updatedUser.name} as ${status}${reason ? ` (${reason})` : ""}`,
        actor: adminUser,
        target: {
          type: "user",
          id: resolvedTargetId || targetUserId,
          label: updatedUser.email || updatedUser.name,
        },
        metadata: {
          status,
          ...(reason ? { reason } : {}),
        },
      });

      return sanitizeAdminUserProfile(updatedUser);
    },

    async updateUserDetails({ rawTargetUserId, body, adminUser }) {
      const targetUserId = validateAdminTargetUserId(rawTargetUserId);
      const cleanPatch = validateAdminUserProfileUpdateBody(body);
      const now = nowProvider();

      const usersCollection = await usersCollectionGetter();
      const existingUser = await usersCollection.findOne(
        buildUserLookupFilter(targetUserId),
        { projection: SAFE_USER_PROJECTION }
      );

      if (!existingUser || existingUser.isDeleted === true) {
        throw new ApiError("User not found", 404, { code: "NOT_FOUND" });
      }

      const resolvedTargetId = resolveUserIdentifier(existingUser);
      const updateResult = await usersCollection.findOneAndUpdate(
        buildUserLookupFilter(targetUserId),
        {
          $set: {
            ...cleanPatch,
            updatedAt: now,
          },
        },
        {
          returnDocument: "after",
          projection: SAFE_USER_PROJECTION,
        }
      );

      const updatedUser =
        updateResult && typeof updateResult === "object" && "value" in updateResult
          ? updateResult.value
          : updateResult;

      if (!updatedUser) {
        throw new ApiError("User not found", 404, { code: "NOT_FOUND" });
      }

      await auditLogger({
        action: "USER_UPDATED",
        category: "user",
        severity: "info",
        summary: `Updated profile details for ${updatedUser.email || updatedUser.name}`,
        actor: adminUser,
        target: {
          type: "user",
          id: resolvedTargetId || targetUserId,
          label: updatedUser.email || updatedUser.name,
        },
        metadata: {
          updatedFields: Object.keys(cleanPatch),
        },
      });

      return sanitizeAdminUserProfile(updatedUser);
    },

    async deleteUser({ rawTargetUserId, adminUser }) {
      const targetUserId = validateAdminTargetUserId(rawTargetUserId);
      const now = nowProvider();

      const usersCollection = await usersCollectionGetter();
      const existingUser = await usersCollection.findOne(
        buildUserLookupFilter(targetUserId),
        { projection: SAFE_USER_PROJECTION }
      );

      if (!existingUser || existingUser.isDeleted === true) {
        throw new ApiError("User not found", 404, { code: "NOT_FOUND" });
      }

      const resolvedTargetId = resolveUserIdentifier(existingUser);
      if (resolvedTargetId && String(resolvedTargetId) === String(adminUser?.id)) {
        throw new ApiError(
          "Administrators cannot delete their own account.",
          400,
          { code: "SELF_DELETE_FORBIDDEN" }
        );
      }

      await ensureAnotherActiveAdminExists(usersCollection, existingUser);

      await usersCollection.findOneAndUpdate(
        buildUserLookupFilter(targetUserId),
        {
          $set: {
            isDeleted: true,
            active: false,
            disabled: true,
            status: "Deleted",
            deletedAt: now,
            deletedBy: adminUser?.id || "",
            updatedAt: now,
          },
        },
        { projection: SAFE_USER_PROJECTION }
      );

      await revokeUserSessionsSafely(existingUser, targetUserId);

      await auditLogger({
        action: "USER_DELETED",
        category: "user",
        severity: "danger",
        summary: `Archived & removed user account ${existingUser.email || existingUser.name}`,
        actor: adminUser,
        target: {
          type: "user",
          id: resolvedTargetId || targetUserId,
          label: existingUser.email || existingUser.name,
        },
      });

      return {
        deleted: true,
        userId: resolvedTargetId || targetUserId,
      };
    },
  };
}

export const adminUserService = createAdminUserService();
