import { pathToFileURL } from "node:url";

import { getAuth, initAuth, resetAuth } from "../config/auth.js";
import { closeDB, connectDB } from "../config/db.js";
import { ensureDatabaseCollectionsAndIndexes } from "../config/dbIndexes.js";
import { env, redactMongoUri } from "../config/env.js";
import { USER_ROLES } from "../constants/roles.js";
import {
  buildUserLookupFilter,
  getUsersCollection,
} from "../models/user.model.js";
import {
  validateSignupName,
  validateSignupPassword,
} from "../utils/authHelpers.js";
import { cleanString, validateEmailAddress } from "../validators/validationHelpers.js";

/**
 * Trusted server-side bootstrap provisioning the initial GearNest Admin account
 * via Better Auth's official signUpEmail API (never inserting plaintext passwords
 * and refusing to silently promote existing Customer or Owner accounts).
 */
export async function seedInitialAdmin({
  name = process.env.ADMIN_NAME,
  email = process.env.ADMIN_EMAIL,
  password = process.env.ADMIN_PASSWORD,
  usersCollectionGetter = getUsersCollection,
  signUpFn = null,
} = {}) {
  const nameCheck = validateSignupName(name);
  if (!nameCheck.valid) {
    throw new Error(`Invalid ADMIN_NAME: ${nameCheck.message}`);
  }

  const normalizedEmail = validateEmailAddress(email);
  if (!normalizedEmail) {
    throw new Error("Invalid or missing ADMIN_EMAIL environment variable.");
  }

  const passwordCheck = validateSignupPassword(password);
  if (!passwordCheck.valid) {
    throw new Error(`Invalid ADMIN_PASSWORD: ${passwordCheck.message}`);
  }

  const usersCollection = await usersCollectionGetter();
  const existingUser = await usersCollection.findOne({ email: normalizedEmail });

  if (existingUser) {
    if (existingUser.role === USER_ROLES.ADMIN) {
      return {
        action: "already_exists",
        email: normalizedEmail,
        role: USER_ROLES.ADMIN,
      };
    }

    throw new Error(
      `Account for ${normalizedEmail} already exists with role "${
        existingUser.role || "unknown"
      }". Refusing silent role escalation.`
    );
  }

  const signUp =
    signUpFn ||
    ((body) => {
      const auth = getAuth();
      return auth.api.signUpEmail({ body });
    });

  const signUpResult = await signUp({
    name: cleanString(nameCheck.value),
    email: normalizedEmail,
    password,
  });

  const createdUserId = signUpResult?.user?.id;
  const createdLookup = createdUserId
    ? buildUserLookupFilter(createdUserId)
    : { email: normalizedEmail };

  const promoteResult = await usersCollection.findOneAndUpdate(
    createdLookup,
    {
      $set: {
        role: USER_ROLES.ADMIN,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  const promotedUser =
    promoteResult && typeof promoteResult === "object" && "value" in promoteResult
      ? promoteResult.value
      : promoteResult;

  if (!promotedUser || promotedUser.role !== USER_ROLES.ADMIN) {
    throw new Error(
      `Failed to assign Admin role to bootstrapped account for ${normalizedEmail}.`
    );
  }

  return {
    action: "created",
    email: normalizedEmail,
    role: promotedUser.role,
    id: String(promotedUser.id || promotedUser._id),
  };
}

async function runCli() {
  try {
    const db = await connectDB();
    await ensureDatabaseCollectionsAndIndexes(db);
    initAuth();

    const result = await seedInitialAdmin();
    if (result.action === "already_exists") {
      console.log(
        `[GearNest Seed] Admin already provisioned for ${result.email} (${env.dbName}).`
      );
    } else {
      console.log(
        `[GearNest Seed] Initial Admin provisioned successfully for ${result.email} (id=${result.id}, role=${result.role}).`
      );
    }

    resetAuth();
    await closeDB();
    process.exit(0);
  } catch (error) {
    console.error(
      `[GearNest Seed] Admin bootstrap aborted: ${redactMongoUri(
        error?.message || String(error)
      )}`
    );
    resetAuth();
    await closeDB().catch(() => null);
    process.exit(1);
  }
}

const isDirectCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectCli) {
  runCli();
}
