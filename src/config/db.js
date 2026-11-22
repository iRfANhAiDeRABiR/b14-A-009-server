import { MongoClient, ServerApiVersion } from "mongodb";

import { redactMongoUri, requireDatabaseEnv } from "./env.js";
import { ApiError } from "../utils/ApiError.js";

let mongoClient = null;
let database = null;
let connectPromise = null;

function mapDatabaseStartupError(error) {
  if (error instanceof ApiError) {
    return error;
  }

  const safeMsg = redactMongoUri(error?.message || "Failed to connect to MongoDB.");

  if (error?.code === 18 || error?.code === 8000 || /auth/i.test(safeMsg)) {
    return new ApiError("MongoDB authentication failed. Verify MONGODB_URI credentials.", 503, {
      code: "DB_AUTH_FAILED",
      isOperational: true,
    });
  }

  if (
    error?.name === "MongoServerSelectionError" ||
    error?.name === "MongoNetworkTimeoutError" ||
    error?.name === "MongoNetworkError"
  ) {
    return new ApiError("Unable to reach MongoDB server within timeout window.", 503, {
      code: "DB_UNAVAILABLE",
      isOperational: true,
    });
  }

  return new ApiError(`MongoDB connection failed: ${safeMsg}`, 503, {
    code: "DB_CONNECTION_ERROR",
    isOperational: true,
  });
}

/**
 * Establishes and verifies a singleton MongoDB connection shared across the API.
 * Prevents duplicate MongoClient instances under concurrent calls.
 */
export async function connectDB() {
  if (database && mongoClient) {
    return database;
  }

  if (connectPromise) {
    return connectPromise;
  }

  const { mongodbUri, dbName, connectTimeoutMs, serverSelectionTimeoutMs, socketTimeoutMs } =
    requireDatabaseEnv();

  connectPromise = (async () => {
    const client = new MongoClient(mongodbUri, {
      // strict: false keeps text search indexes ($text) compatible with Stable API v1.
      serverApi: {
        version: ServerApiVersion.v1,
        strict: false,
        deprecationErrors: true,
      },
      maxPoolSize: 20,
      minPoolSize: 2,
      connectTimeoutMS: connectTimeoutMs,
      serverSelectionTimeoutMS: serverSelectionTimeoutMs,
      socketTimeoutMS: socketTimeoutMs,
    });

    try {
      await client.connect();
      const db = client.db(dbName);
      await db.command({ ping: 1 });

      mongoClient = client;
      database = db;
      return database;
    } catch (error) {
      await client.close().catch(() => null);
      mongoClient = null;
      database = null;
      throw mapDatabaseStartupError(error);
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

/**
 * Returns the initialized singleton MongoDB Db instance.
 */
export function getDB() {
  if (!database || !mongoClient) {
    throw new ApiError(
      "Database connection is not initialized. Call connectDB() first.",
      503,
      { code: "DB_NOT_INITIALIZED", isOperational: true }
    );
  }
  return database;
}

/**
 * Returns the initialized singleton MongoClient instance (e.g., for transactions or Better Auth adapter).
 */
export function getClient() {
  if (!mongoClient) {
    throw new ApiError(
      "MongoClient is not initialized. Call connectDB() first.",
      503,
      { code: "DB_NOT_INITIALIZED", isOperational: true }
    );
  }
  return mongoClient;
}

/**
 * Performs a safe, credential-free readiness ping against the active database connection.
 */
export async function checkDBHealth() {
  if (!database || !mongoClient) {
    return { connected: false, status: "disconnected" };
  }

  try {
    await database.command({ ping: 1 });
    return { connected: true, status: "connected" };
  } catch {
    return { connected: false, status: "disconnected" };
  }
}

/**
 * Gracefully closes the active MongoClient connection and resets singleton references.
 */
export async function closeDB() {
  if (connectPromise) {
    await connectPromise.catch(() => null);
  }

  const clientToClose = mongoClient;
  mongoClient = null;
  database = null;
  connectPromise = null;

  if (clientToClose) {
    await clientToClose.close();
  }
}
