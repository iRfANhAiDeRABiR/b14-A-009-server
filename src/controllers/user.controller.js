import { userService } from "../services/user.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export function createUserController(service = userService) {
  return {
    getMe: asyncHandler(async (req, res) => {
      const profile = await service.getCurrentUserProfile(req.user.id);
      return sendSuccess(res, {
        statusCode: 200,
        message: "Profile retrieved successfully",
        data: profile,
      });
    }),

    updateMe: asyncHandler(async (req, res) => {
      const updatedProfile = await service.updateCurrentUserProfile(
        req.user.id,
        req.body
      );
      return sendSuccess(res, {
        statusCode: 200,
        message: "Profile updated successfully",
        data: updatedProfile,
      });
    }),
  };
}

export const userController = createUserController();
