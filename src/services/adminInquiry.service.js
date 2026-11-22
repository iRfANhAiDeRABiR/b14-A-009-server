import { CONTACT_MESSAGE_STATUSES } from "../constants/booking.js";
import { getContactMessagesCollection } from "../models/collections.js";
import { ApiError } from "../utils/ApiError.js";
import {
  validateAdminInquiryIdParam,
  validateAdminInquiryListQuery,
  validateAdminInquiryStatusBody,
} from "../validators/adminInquiry.validator.js";
import { recordAuditEventSafe } from "./auditLog.service.js";

function formatInquiryRecord(doc) {
  if (!doc || typeof doc !== "object") return null;
  return {
    _id: doc._id ? String(doc._id) : "",
    name: String(doc.name || ""),
    email: String(doc.email || ""),
    inquiryType: String(doc.inquiryType || "General Inquiry"),
    subject: String(doc.subject || ""),
    message: String(doc.message || ""),
    status: String(doc.status || CONTACT_MESSAGE_STATUSES.NEW),
    adminNote: String(doc.adminNote || ""),
    reviewedAt: doc.reviewedAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

/**
 * Factory creating Admin contact inquiry inbox services backed by `contactMessages`.
 */
export function createAdminInquiryService({
  contactMessagesCollectionGetter = getContactMessagesCollection,
  auditLogger = recordAuditEventSafe,
  nowProvider = () => new Date(),
} = {}) {
  return {
    async listInquiries(rawQuery = {}) {
      const { escapedSearch, status, inquiryType, sort, page, limit } =
        validateAdminInquiryListQuery(rawQuery);

      const filter = {};
      if (status !== "all") {
        filter.status = status;
      }
      if (inquiryType !== "all") {
        filter.inquiryType = inquiryType;
      }
      if (escapedSearch) {
        const rx = { $regex: escapedSearch, $options: "i" };
        filter.$or = [
          { name: rx },
          { email: rx },
          { subject: rx },
          { message: rx },
        ];
      }

      const sortSpec = sort === "oldest" ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 };
      const skip = (page - 1) * limit;

      const collection = await contactMessagesCollectionGetter();
      const [totalItems, docs, totalAll, newCount, inProgressCount, resolvedCount] =
        await Promise.all([
          collection.countDocuments(filter),
          collection.find(filter).sort(sortSpec).skip(skip).limit(limit).toArray(),
          collection.countDocuments({}),
          collection.countDocuments({ status: CONTACT_MESSAGE_STATUSES.NEW }),
          collection.countDocuments({ status: CONTACT_MESSAGE_STATUSES.IN_PROGRESS }),
          collection.countDocuments({ status: CONTACT_MESSAGE_STATUSES.RESOLVED }),
        ]);

      return {
        items: docs.map(formatInquiryRecord).filter(Boolean),
        pagination: {
          currentPage: page,
          limit,
          totalItems,
          totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / limit),
        },
        summary: {
          totalAll,
          newCount,
          inProgressCount,
          resolvedCount,
        },
      };
    },

    async updateInquiryStatus({ inquiryId, body, adminUser }) {
      const objectId = validateAdminInquiryIdParam(inquiryId);
      const { status, adminNote } = validateAdminInquiryStatusBody(body);
      const now = nowProvider();

      const collection = await contactMessagesCollectionGetter();
      const existing = await collection.findOne({ _id: objectId });
      if (!existing) {
        throw new ApiError("Contact inquiry not found", 404, { code: "NOT_FOUND" });
      }

      const updateFields = {
        status,
        reviewedAt: now,
        reviewedBy: adminUser?.id || "",
        updatedAt: now,
      };
      if (adminNote !== undefined) {
        updateFields.adminNote = adminNote;
      }

      const result = await collection.findOneAndUpdate(
        { _id: objectId },
        { $set: updateFields },
        { returnDocument: "after" }
      );
      const updated =
        result && typeof result === "object" && "value" in result ? result.value : result;

      await auditLogger({
        action: "INQUIRY_STATUS_UPDATED",
        category: "inquiry",
        severity: status === CONTACT_MESSAGE_STATUSES.RESOLVED ? "info" : "warning",
        summary: `Updated inquiry "${existing.subject}" from ${existing.status} to ${status}`,
        actor: adminUser,
        target: {
          type: "inquiry",
          id: String(objectId),
          label: existing.subject || existing.email,
        },
        metadata: {
          previousStatus: existing.status,
          nextStatus: status,
          senderEmail: existing.email,
        },
      });

      return formatInquiryRecord(updated || { ...existing, ...updateFields });
    },

    async deleteInquiry({ inquiryId, adminUser }) {
      const objectId = validateAdminInquiryIdParam(inquiryId);
      const collection = await contactMessagesCollectionGetter();
      const existing = await collection.findOne({ _id: objectId });
      if (!existing) {
        throw new ApiError("Contact inquiry not found", 404, { code: "NOT_FOUND" });
      }

      await collection.deleteOne({ _id: objectId });

      await auditLogger({
        action: "INQUIRY_DELETED",
        category: "inquiry",
        severity: "danger",
        summary: `Deleted inquiry "${existing.subject}" from ${existing.email}`,
        actor: adminUser,
        target: {
          type: "inquiry",
          id: String(objectId),
          label: existing.subject || existing.email,
        },
      });

      return { deleted: true, inquiryId: String(objectId) };
    },
  };
}

export const adminInquiryService = createAdminInquiryService();
