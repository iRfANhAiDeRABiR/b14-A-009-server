import {
  buildUserLookupFilter,
  getUsersCollection,
  SAFE_USER_PROJECTION,
  sanitizeUserProfile,
} from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { validateProfileUpdatePayload } from "../validators/user.validator.js";

/**
 * Factory creating user profile service methods with injectable collection getter for tests.
 */
export function createUserService({
  usersCollectionGetter = getUsersCollection,
} = {}) {
  return {
    async getCurrentUserProfile(userId) {
      const usersCollection = await usersCollectionGetter();
      const user = await usersCollection.findOne(buildUserLookupFilter(userId), {
        projection: SAFE_USER_PROJECTION,
      });

      if (!user) {
        throw new ApiError("User not found", 404, { code: "NOT_FOUND" });
      }

      return sanitizeUserProfile(user);
    },

    async updateCurrentUserProfile(userId, payload) {
      const safeFields = validateProfileUpdatePayload(payload);
      const usersCollection = await usersCollectionGetter();

      const updateResult = await usersCollection.findOneAndUpdate(
        buildUserLookupFilter(userId),
        {
          $set: {
            ...safeFields,
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

      return sanitizeUserProfile(updatedUser);
    },
  };
}

export const userService = createUserService();
