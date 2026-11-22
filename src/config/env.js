import "dotenv/config";

const ALLOWED_NODE_ENVS = new Set(["development", "production", "test"]);

function parsePort(rawPort) {
  if (rawPort === undefined || rawPort === null || String(rawPort).trim() === "") {
    return 5000;
  }

  const parsed = Number(rawPort);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT "${rawPort}". Expected an integer between 1 and 65535.`);
  }

  return parsed;
}

function normalizeOrigin(origin) {
  const cleaned = String(origin || "").trim().replace(/\/+$/, "");
  if (!cleaned) return "";

  if (cleaned === "*") {
    throw new Error(
      'Wildcard "*" is not permitted in CORS_ORIGINS when credentialed requests are enabled.'
    );
  }

  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported origin protocol in "${cleaned}".`);
    }
    return parsed.origin;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid origin URL in configuration: "${cleaned}".`);
    }
    throw error;
  }
}

function parseCorsOrigins({ rawCorsOrigins, rawClientUrl, nodeEnv }) {
  const candidates = [];

  if (rawCorsOrigins) {
    for (const entry of String(rawCorsOrigins).split(",")) {
      const normalized = normalizeOrigin(entry);
      if (normalized) candidates.push(normalized);
    }
  }

  if (rawClientUrl) {
    const normalizedClient = normalizeOrigin(rawClientUrl);
    if (normalizedClient) candidates.push(normalizedClient);
  }

  if (candidates.length === 0 && nodeEnv !== "production") {
    candidates.push("http://localhost:3000");
  }

  return Object.freeze([...new Set(candidates)]);
}

const rawNodeEnv = String(process.env.NODE_ENV || "development").trim().toLowerCase();
const nodeEnv = ALLOWED_NODE_ENVS.has(rawNodeEnv) ? rawNodeEnv : "development";
const port = parsePort(process.env.PORT);
const clientUrl = process.env.CLIENT_URL
  ? normalizeOrigin(process.env.CLIENT_URL)
  : nodeEnv !== "production"
    ? "http://localhost:3000"
    : "";
const corsOrigins = parseCorsOrigins({
  rawCorsOrigins: process.env.CORS_ORIGINS,
  rawClientUrl: process.env.CLIENT_URL,
  nodeEnv,
});

export const env = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === "production",
  isDevelopment: nodeEnv === "development",
  isTest: nodeEnv === "test",
  port,
  clientUrl,
  corsOrigins,
  jsonBodyLimit: String(process.env.JSON_BODY_LIMIT || "100kb").trim(),
  mongodbUri: String(process.env.MONGODB_URI || "").trim(),
  dbName: String(process.env.DB_NAME || "").trim(),
  mongodbTransactions:
    String(process.env.MONGODB_TRANSACTIONS || "true").trim().toLowerCase() !== "false",
  dbConnectTimeoutMs: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10000,
  dbServerSelectionTimeoutMs: Number(process.env.DB_SERVER_SELECTION_TIMEOUT_MS) || 5000,
  dbSocketTimeoutMs: Number(process.env.DB_SOCKET_TIMEOUT_MS) || 20000,
  betterAuthUrl: String(process.env.BETTER_AUTH_URL || "").trim().replace(/\/+$/, ""),
});

/**
 * Strips credentials from MongoDB connection strings before emitting logs or error strings.
 */
export function redactMongoUri(text = "") {
  return String(text).replace(
    /(mongodb(?:\+srv)?:\/\/)([^/\s@]+)@/gi,
    "$1***:***@"
  );
}

/**
 * Validates required environment keys when a milestone or feature activates them.
 * Keeps early milestones runnable without future integration secrets.
 */
export function requireEnv(keys = []) {
  const missing = keys.filter((key) => {
    const value = process.env[key];
    return typeof value !== "string" || value.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`
    );
  }
}

/**
 * Validates MongoDB configuration dynamically when establishing a database connection.
 */
export function requireDatabaseEnv() {
  requireEnv(["MONGODB_URI", "DB_NAME"]);

  const mongodbUri = String(process.env.MONGODB_URI || "").trim();
  const dbName = String(process.env.DB_NAME || "").trim();

  if (!/^mongodb(?:\+srv)?:\/\/\S+/i.test(mongodbUri)) {
    throw new Error(
      "Invalid MONGODB_URI format. Expected a connection string starting with mongodb:// or mongodb+srv://."
    );
  }

  return {
    mongodbUri,
    dbName,
    connectTimeoutMs: env.dbConnectTimeoutMs,
    serverSelectionTimeoutMs: env.dbServerSelectionTimeoutMs,
    socketTimeoutMs: env.dbSocketTimeoutMs,
  };
}
