import { adminUserService } from "../services/adminUser.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export function createAdminUserController(service = adminUserService) {
  return {
    getUsers: asyncHandler(async (req, res) => {
      const result = await service.listUsers(req.query);
      return sendSuccess(res, {
        statusCode: 200,
        message: "Users retrieved successfully",
        data: result.users,
        pagination: result.pagination,
      });
    }),

    getUserById: asyncHandler(async (req, res) => {
      const user = await service.getUserById(req.params.id);
      return sendSuccess(res, {
        statusCode: 200,
        message: "User retrieved successfully",
        data: user,
      });
    }),

    updateUserRole: asyncHandler(async (req, res) => {
      const { user, unchanged } = await service.updateUserRole({
        rawTargetUserId: req.params.id,
        body: req.body,
        adminUserId: req.user.id,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: unchanged
          ? `User already has the ${user.role} role`
          : "User role updated successfully",
        data: user,
      });
    }),
  };
}

export const adminUserController = createAdminUserController();
