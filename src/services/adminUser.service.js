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
} from "../validators/adminUser.validator.js";

const SORT_MAP = Object.freeze({
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  name_asc: { name: 1, _id: 1 },
  name_desc: { name: -1, _id: -1 },
});

/**
 * Factory creating Admin user governance service methods with injectable collection getter for tests.
 */
export function createAdminUserService({
  usersCollectionGetter = getUsersCollection,
} = {}) {
  return {
    async listUsers(rawQuery = {}) {
      const { escapedSearch, role, sort, page, limit } =
        validateAdminUserListQuery(rawQuery);

      const filter = {};
      if (role !== "all") {
        filter.role = role;
      }
      if (escapedSearch) {
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

      if (!user) {
        throw new ApiError("User not found", 404, { code: "NOT_FOUND" });
      }

      return sanitizeAdminUserProfile(user);
    },

    async updateUserRole({ rawTargetUserId, body, adminUserId }) {
      const targetUserId = validateAdminTargetUserId(rawTargetUserId);
      const nextRole = validateAdminRoleUpdateBody(body);

      const usersCollection = await usersCollectionGetter();
      const existingUser = await usersCollection.findOne(
        buildUserLookupFilter(targetUserId),
        { projection: SAFE_USER_PROJECTION }
      );

      if (!existingUser) {
        throw new ApiError("User not found", 404, { code: "NOT_FOUND" });
      }

      const resolvedTargetId = resolveUserIdentifier(existingUser);
      if (resolvedTargetId && String(resolvedTargetId) === String(adminUserId)) {
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

      const updateResult = await usersCollection.findOneAndUpdate(
        buildUserLookupFilter(targetUserId),
        {
          $set: {
            role: nextRole,
            updatedAt: new Date(),
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

      return {
        user: sanitizeAdminUserProfile(updatedUser),
        unchanged: false,
      };
    },
  };
}

export const adminUserService = createAdminUserService();
