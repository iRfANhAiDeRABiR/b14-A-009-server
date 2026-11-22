import {
  getEquipmentCollection,
  getUsersCollection,
} from "../models/collections.js";
import {
  SAFE_EQUIPMENT_OWNER_PROJECTION,
  sanitizeEquipmentRecord,
} from "../models/equipment.model.js";
import {
  buildUserLookupFilter,
  resolveUserIdentifier,
} from "../models/user.model.js";
import { buildPublicEquipmentMongoQuery } from "../utils/equipmentQuery.js";
import { validateEquipmentListQuery } from "../validators/equipmentQuery.validator.js";

export async function hydrateEquipmentOwners(usersCollection, ownerIds) {
  const uniqueIds = [
    ...new Set(ownerIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ];
  if (uniqueIds.length === 0) return new Map();

  const orClauses = uniqueIds.flatMap((id) => buildUserLookupFilter(id).$or);
  const docs = await usersCollection
    .find({ $or: orClauses }, { projection: SAFE_EQUIPMENT_OWNER_PROJECTION })
    .toArray();

  const map = new Map();
  for (const doc of docs) {
    const resolved = resolveUserIdentifier(doc);
    if (resolved) map.set(resolved, doc);
    if (doc._id) map.set(String(doc._id), doc);
    if (doc.id) map.set(String(doc.id), doc);
  }
  return map;
}

/**
 * Factory creating MongoDB-backed public equipment search, filter, sort, and pagination queries.
 */
export function createEquipmentQueryService({
  equipmentCollectionGetter = getEquipmentCollection,
  usersCollectionGetter = getUsersCollection,
} = {}) {
  return {
    async queryPublicEquipment(rawQuery = {}) {
      const validated = validateEquipmentListQuery(rawQuery);
      const { filter, sortOptions, skip, limit, page } =
        buildPublicEquipmentMongoQuery(validated);

      const [equipmentCollection, usersCollection] = await Promise.all([
        equipmentCollectionGetter(),
        usersCollectionGetter(),
      ]);

      const [totalItems, docs] = await Promise.all([
        equipmentCollection.countDocuments(filter),
        equipmentCollection
          .find(filter)
          .sort(sortOptions)
          .skip(skip)
          .limit(limit)
          .toArray(),
      ]);

      const ownerMap = await hydrateEquipmentOwners(
        usersCollection,
        docs.map((item) => item.ownerId)
      );

      const items = docs.map((doc) =>
        sanitizeEquipmentRecord(doc, ownerMap.get(String(doc.ownerId)) || null)
      );

      return {
        items,
        pagination: {
          currentPage: page,
          limit,
          totalItems,
          totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / limit),
        },
      };
    },
  };
}

export const equipmentQueryService = createEquipmentQueryService();
