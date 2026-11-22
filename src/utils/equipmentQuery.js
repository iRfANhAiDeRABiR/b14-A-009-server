import { EQUIPMENT_STATUSES } from "../constants/equipment.js";
import { escapeRegexInput } from "./regex.js";

const SORT_OPTION_MAP = Object.freeze({
  price_asc: { rentalPrice: 1, _id: 1 },
  price_desc: { rentalPrice: -1, _id: 1 },
  newest: { createdAt: -1, _id: -1 },
  featured: { createdAt: -1, _id: -1 },
});

/**
 * Translates validated public catalog query parameters into a MongoDB filter,
 * sort specification, and skip/limit bounds.
 * Unconditionally restricts `status` to `Approved` regardless of client query parameters.
 */
export function buildPublicEquipmentMongoQuery(validatedParams = {}) {
  const {
    search = "",
    category = "all",
    rentalType = "all",
    minPrice = null,
    maxPrice = null,
    availability = "all",
    sort = "newest",
    page = 1,
    limit = 9,
  } = validatedParams;

  // Hardcode Approved visibility unconditionally for the public marketplace catalog
  const filter = {
    status: EQUIPMENT_STATUSES.APPROVED,
  };

  if (category && category !== "all") {
    filter.category = category;
  }

  if (rentalType && rentalType !== "all") {
    filter.rentalType = rentalType;
  }

  if (minPrice !== null || maxPrice !== null) {
    filter.rentalPrice = {};
    if (minPrice !== null) {
      filter.rentalPrice.$gte = minPrice;
    }
    if (maxPrice !== null) {
      filter.rentalPrice.$lte = maxPrice;
    }
  }

  const andClauses = [];

  if (availability === "available") {
    filter.availableQuantity = { $gt: 0 };
  } else if (availability === "unavailable") {
    // Handles zero/negative inventory as well as legacy records missing availableQuantity
    andClauses.push({
      $or: [
        { availableQuantity: { $lte: 0 } },
        { availableQuantity: null },
        { availableQuantity: { $exists: false } },
      ],
    });
  }

  if (search) {
    const escaped = escapeRegexInput(search);
    const searchRegex = { $regex: escaped, $options: "i" };
    andClauses.push({
      $or: [
        { name: searchRegex },
        { title: searchRegex },
        { location: searchRegex },
        { category: searchRegex },
      ],
    });
  }

  if (andClauses.length === 1) {
    Object.assign(filter, andClauses[0]);
  } else if (andClauses.length > 1) {
    filter.$and = andClauses;
  }

  const sortOptions = SORT_OPTION_MAP[sort] || SORT_OPTION_MAP.newest;
  const skip = (page - 1) * limit;

  return {
    filter,
    sortOptions,
    skip,
    limit,
    page,
  };
}
