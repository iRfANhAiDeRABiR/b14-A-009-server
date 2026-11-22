import { contactService } from "../services/contact.service.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Factory creating HTTP handlers for public contact inquiry submissions.
 */
export function createContactController(service = contactService) {
  return {
    submitMessage: asyncHandler(async (req, res) => {
      const saved = await service.submitMessage(req.body);

      return sendSuccess(res, {
        statusCode: 201,
        message: "Your inquiry has been received and saved by our team.",
        data: saved,
      });
    }),
  };
}

export const contactController = createContactController();
