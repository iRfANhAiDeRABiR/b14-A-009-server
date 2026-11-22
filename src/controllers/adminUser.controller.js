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
        adminUser: req.user,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: unchanged
          ? `User already has the ${user.role} role`
          : "User role updated successfully",
        data: user,
      });
    }),

    updateUserStatus: asyncHandler(async (req, res) => {
      const user = await service.updateUserStatus({
        rawTargetUserId: req.params.id,
        body: req.body,
        adminUser: req.user,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: `User account marked as ${user.accountStatus}`,
        data: user,
      });
    }),

    updateUserDetails: asyncHandler(async (req, res) => {
      const user = await service.updateUserDetails({
        rawTargetUserId: req.params.id,
        body: req.body,
        adminUser: req.user,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "User profile updated successfully",
        data: user,
      });
    }),

    deleteUser: asyncHandler(async (req, res) => {
      const result = await service.deleteUser({
        rawTargetUserId: req.params.id,
        adminUser: req.user,
      });

      return sendSuccess(res, {
        statusCode: 200,
        message: "User account removed successfully",
        data: result,
      });
    }),
  };
}

export const adminUserController = createAdminUserController();
