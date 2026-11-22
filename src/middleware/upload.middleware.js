import path from "node:path";
import multer from "multer";
import { ApiError } from "../utils/ApiError.js";

export const MAX_EQUIPMENT_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/**
 * Inspects leading magic bytes of an uploaded buffer to verify actual image format
 * beyond mutable MIME headers or filenames.
 */
export function detectImageSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // WEBP: RIFF....WEBP
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_EQUIPMENT_IMAGE_BYTES,
    files: 1,
  },
  fileFilter(_req, file, cb) {
    const mime = String(file?.mimetype || "").toLowerCase();
    const ext = path.extname(String(file?.originalname || "")).toLowerCase();

    if (!ALLOWED_MIME_TYPES.has(mime) || !ALLOWED_EXTENSIONS.has(ext)) {
      cb(
        new ApiError(
          "Unsupported image format. Please upload a JPG, JPEG, PNG, or WEBP image.",
          400,
          { code: "UNSUPPORTED_FILE_TYPE" }
        )
      );
      return;
    }

    cb(null, true);
  },
});

/**
 * Handles multipart/form-data image parsing under field `"image"`, enforcing size,
 * MIME type, extension, non-empty size, and magic-byte image signatures.
 */
export function uploadEquipmentImageMiddleware(req, res, next) {
  memoryUpload.single("image")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(
          new ApiError("Equipment image must be 5 MB or smaller.", 400, {
            code: "FILE_TOO_LARGE",
          })
        );
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return next(
          new ApiError("Image upload must use multipart field name 'image'.", 400, {
            code: "INVALID_UPLOAD_FIELD",
          })
        );
      }
      return next(new ApiError(err.message || "Invalid file upload.", 400));
    }

    if (err) {
      return next(err);
    }

    if (!req.file || !req.file.buffer || req.file.size <= 0) {
      return next(
        new ApiError("An image file is required and cannot be empty.", 400, {
          code: "EMPTY_FILE_UPLOAD",
        })
      );
    }

    const detectedSignature = detectImageSignature(req.file.buffer);
    if (!detectedSignature) {
      return next(
        new ApiError(
          "Uploaded file content does not match a valid JPG, PNG, or WEBP image.",
          400,
          { code: "INVALID_IMAGE_SIGNATURE" }
        )
      );
    }

    req.validatedImageType = detectedSignature;
    return next();
  });
}
