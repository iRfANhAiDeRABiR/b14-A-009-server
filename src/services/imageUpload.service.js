import { ApiError } from "../utils/ApiError.js";
import { cleanString } from "../validators/validationHelpers.js";

const IMGBB_UPLOAD_URL = "https://api.imgbb.com/1/upload";
const PLACEHOLDER_KEY_HINTS = ["your_", "your-", "placeholder", "example"];

function resolveImgbbApiKey() {
  const key = cleanString(process.env.IMGBB_API_KEY);
  if (!key) {
    throw new ApiError(
      "Image upload service is unavailable because IMGBB_API_KEY is not configured.",
      503,
      { code: "UPLOAD_NOT_CONFIGURED" }
    );
  }

  const lower = key.toLowerCase();
  if (
    (lower.startsWith("<") && lower.endsWith(">")) ||
    PLACEHOLDER_KEY_HINTS.some((hint) => lower.includes(hint))
  ) {
    throw new ApiError(
      "Image upload service is unavailable because IMGBB_API_KEY is a placeholder.",
      503,
      { code: "UPLOAD_NOT_CONFIGURED" }
    );
  }

  return key;
}

/**
 * Factory uploading verified in-memory image buffers strictly through the server-side
 * ImgBB endpoint without ever leaking `IMGBB_API_KEY` to responses or logs.
 */
export function createImageUploadService({ fetchFn = globalThis.fetch } = {}) {
  return {
    async uploadEquipmentImage(file) {
      if (!file || !file.buffer || file.buffer.length === 0) {
        throw new ApiError("An image file is required and cannot be empty.", 400, {
          code: "EMPTY_FILE_UPLOAD",
        });
      }

      const apiKey = resolveImgbbApiKey();
      const formData = new FormData();
      formData.append("key", apiKey);
      formData.append("image", file.buffer.toString("base64"));

      let upstreamResponse;
      try {
        upstreamResponse = await fetchFn(IMGBB_UPLOAD_URL, {
          method: "POST",
          body: formData,
        });
      } catch {
        throw new ApiError(
          "Unable to reach the image hosting provider right now.",
          502,
          { code: "UPSTREAM_UPLOAD_FAILED" }
        );
      }

      let payload = null;
      try {
        payload = await upstreamResponse.json();
      } catch {
        payload = null;
      }

      const hostedUrl =
        payload?.data?.display_url || payload?.data?.url || "";
      const deleteUrl = payload?.data?.delete_url || "";

      if (
        !upstreamResponse.ok ||
        !payload?.success ||
        typeof hostedUrl !== "string" ||
        !/^https?:\/\//i.test(hostedUrl.trim())
      ) {
        throw new ApiError(
          "Image hosting provider rejected or failed the upload.",
          502,
          { code: "UPSTREAM_UPLOAD_FAILED" }
        );
      }

      return {
        url: hostedUrl.trim(),
        ...(deleteUrl ? { deleteUrl: String(deleteUrl).trim() } : {}),
      };
    },
  };
}

export const imageUploadService = createImageUploadService();
