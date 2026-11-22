import { getAuditLogsCollection } from "../models/collections.js";
import { cleanString } from "../validators/validationHelpers.js";
import {
  AUDIT_LOG_CATEGORIES,
  AUDIT_LOG_SEVERITIES,
  validateAuditLogListQuery,
} from "../validators/auditLog.validator.js";

function sanitizeActor(actor) {
  if (!actor || typeof actor !== "object") {
    return { id: "system", name: "System", email: "" };
  }
  return {
    id: cleanString(actor.id || actor._id || "system") || "system",
    name: cleanString(actor.name || actor.email || "Administrator") || "Administrator",
    email: cleanString(actor.email || "").toLowerCase(),
  };
}

function sanitizeTarget(target) {
  if (!target || typeof target !== "object") {
    return { type: "system", id: "", label: "" };
  }
  return {
    type: cleanString(target.type || "system").toLowerCase() || "system",
    id: cleanString(target.id || target._id || ""),
    label: cleanString(target.label || ""),
  };
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const safe = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!key || key.startsWith("$")) continue;
    if (value === undefined || typeof value === "function") continue;
    safe[key] =
      value instanceof Date
        ? value.toISOString()
        : typeof value === "string"
          ? value.slice(0, 300)
          : value;
  }
  return safe;
}

function formatAuditLogRecord(doc) {
  if (!doc || typeof doc !== "object") return null;
  return {
    _id: doc._id ? String(doc._id) : "",
    action: String(doc.action || "SYSTEM_EVENT"),
    category: AUDIT_LOG_CATEGORIES.includes(doc.category) ? doc.category : "system",
    severity: AUDIT_LOG_SEVERITIES.includes(doc.severity) ? doc.severity : "info",
    summary: String(doc.summary || ""),
    actor: sanitizeActor(doc.actor),
    target: sanitizeTarget(doc.target),
    metadata:
      doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {},
    createdAt: doc.createdAt || null,
  };
}

/**
 * Factory creating persistent Admin event/audit log service backed by `auditLogs`.
 */
export function createAuditLogService({
  auditLogsCollectionGetter = getAuditLogsCollection,
  nowProvider = () => new Date(),
} = {}) {
  return {
    async recordEvent({
      action,
      category = "system",
      severity = "info",
      summary = "",
      actor = null,
      target = null,
      metadata = {},
    } = {}) {
      const now = nowProvider();
      const doc = {
        action: cleanString(action || "ADMIN_ACTION").toUpperCase(),
        category: AUDIT_LOG_CATEGORIES.includes(category) ? category : "system",
        severity: AUDIT_LOG_SEVERITIES.includes(severity) ? severity : "info",
        summary: cleanString(summary).slice(0, 400),
        actor: sanitizeActor(actor),
        target: sanitizeTarget(target),
        metadata: sanitizeMetadata(metadata),
        createdAt: now,
      };

      const collection = await auditLogsCollectionGetter();
      const result = await collection.insertOne(doc);
      return formatAuditLogRecord({
        ...doc,
        _id: result?.insertedId || doc._id,
      });
    },

    async recordEventSafely(payload) {
      try {
        return await this.recordEvent(payload);
      } catch {
        return null;
      }
    },

    async listLogs(rawQuery = {}) {
      const { escapedSearch, category, severity, sort, page, limit } =
        validateAuditLogListQuery(rawQuery);

      const filter = {};
      if (category !== "all") {
        filter.category = category;
      }
      if (severity !== "all") {
        filter.severity = severity;
      }
      if (escapedSearch) {
        const rx = { $regex: escapedSearch, $options: "i" };
        filter.$or = [
          { action: rx },
          { summary: rx },
          { "target.label": rx },
          { "target.id": rx },
          { "actor.name": rx },
          { "actor.email": rx },
        ];
      }

      const sortSpec = sort === "oldest" ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 };
      const skip = (page - 1) * limit;

      const collection = await auditLogsCollectionGetter();
      const [totalItems, docs, totalAll, userCount, equipmentCount, rentalCount, inquiryCount] =
        await Promise.all([
          collection.countDocuments(filter),
          collection.find(filter).sort(sortSpec).skip(skip).limit(limit).toArray(),
          collection.countDocuments({}),
          collection.countDocuments({ category: "user" }),
          collection.countDocuments({ category: "equipment" }),
          collection.countDocuments({ category: "rental" }),
          collection.countDocuments({ category: "inquiry" }),
        ]);

      return {
        logs: docs.map(formatAuditLogRecord).filter(Boolean),
        pagination: {
          currentPage: page,
          limit,
          totalItems,
          totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / limit),
        },
        summary: {
          totalAll,
          user: userCount,
          equipment: equipmentCount,
          rental: rentalCount,
          inquiry: inquiryCount,
        },
      };
    },
  };
}

export const auditLogService = createAuditLogService();
export const recordAuditEventSafe = (payload) =>
  auditLogService.recordEventSafely(payload);
