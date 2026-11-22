# GearNest API

## Project Overview

GearNest API powers the backend REST services for **GearNest — Equipment Rental Platform**, connecting equipment owners and customers through an organized marketplace.

- **Implemented in Commit 01–03:** Express.js application bootstrap, environment validation, restricted credentialed CORS, Helmet security headers, Morgan HTTP logging, singleton MongoDB Node.js Driver connection (`connectDB`, `getDB`, `getClient`, `closeDB`), collection architecture, idempotent database index initialization, Better Auth authentication + `@better-auth/mongo-adapter` integration (`users` collection + `sessions`/`accounts`/`verifications`/`jwks`), email/password registration & login with server-side complexity hooks, conditional Google OAuth setup, `jwt()` plugin (`/api/auth/token` & `/api/auth/jwks`), centralized error handling, liveness (`GET /api/health`), and readiness (`GET /api/health/ready`) endpoints.
- **Planned in subsequent commits:** JWT & RBAC route protection middleware (Commit 04), User role/profile management APIs (Commit 05+), Equipment/Favorites/Booking/Owner/Admin APIs, ImgBB image upload proxying, Stripe Checkout & webhook processing (Commit 10+), and Contact message endpoints.

---

## Technology Stack

### Implemented
- **Runtime:** Node.js (ES Modules)
- **Framework:** Express.js (`^5.1.0`)
- **Language:** JavaScript
- **Database & Driver:** MongoDB via Official MongoDB Node.js Driver (`^7.x`)
- **Authentication & Tokens:** Better Auth (`better-auth`, `@better-auth/mongo-adapter`, `better-auth/plugins` `jwt()`)
- **Security & Middleware:** `helmet`, `cors`, `morgan`, `dotenv`, Better Auth rate limiting

### Planned Integrations
- **Authorization Middleware:** JWT verification & RBAC middleware (`verifyToken`, role guards — Commit 04)
- **Payments:** Stripe Checkout & webhook verification (Commit 10)
- **Media Hosting:** ImgBB API integration

---

## Installation

Install backend dependencies from the `server` directory:

```bash
npm install
```

---

## Environment Setup

Copy `.env.example` to `.env` (never commit `.env` or real MongoDB credentials):

```bash
cp .env.example .env
```

Required variables for Commit 02 startup:

- `NODE_ENV` — Runtime mode (`development`, `production`, or `test`)
- `PORT` — HTTP listener port (default `5000`)
- `CLIENT_URL` — Primary frontend URL (default `http://localhost:3000`)
- `CORS_ORIGINS` — Comma-separated allowed browser origins (never `*` with credentials)
- `MONGODB_URI` — MongoDB connection string (`mongodb://...` or `mongodb+srv://...`)
- `DB_NAME` — Target MongoDB database name (for example `gearnest`)

Planned placeholders (`BETTER_AUTH_*`, `GOOGLE_CLIENT_*`, `STRIPE_*`, `IMGBB_API_KEY`) remain optional until their respective milestones.

---

## Database Connection Architecture

- Implemented in `src/config/db.js` using a singleton `MongoClient` + `Db` instance shared across all models and endpoints.
- `connectDB()` prevents duplicate connections on concurrent calls, verifies connectivity via `{ ping: 1 }`, and redacts connection-string credentials from logs and error messages.
- `server.js` connects to MongoDB and initializes collections and indexes before opening the HTTP listener.
- Graceful shutdown (`SIGINT` / `SIGTERM`) closes the HTTP listener for active requests first before closing MongoDB via `closeDB()`.

---

## Collections & Data Models

- **`users`**: Shared with Better Auth (`usePlural: true`) including `name`, `email`, `emailVerified`, `image`, `phone`, `address`, `role` (`Customer` | `Owner` | `Admin`, defaulting to `Customer`), `createdAt`, `updatedAt`.
- **`equipment`**: Equipment catalog documents with `status` (`Pending` | `Approved` | `Rejected`, defaulting to `Pending`), categories, rental types (`Daily` | `Weekly` | `Monthly`), `rentalPrice > 0`, integer `availableQuantity >= 0`, `ownerId` preserving Better Auth ID types.
- **`bookings`**: Reservation records referencing `customerId`, `ownerId`, and `equipmentId`, `Date` start/end dates (`startDate <= endDate`), positive integer `quantity`, monetary totals (`totalAmount`, `currency`), `paymentStatus`, and `bookingStatus`.
- **`favorites`**: Customer wishlist associations (`userId`, `equipmentId`, `createdAt`) protected against duplicates.
- **`payments`**: Server-managed payment transaction tracking referencing `bookingId`, `customerId`, `ownerId`, `equipmentId`, Stripe references, and `amount` (major units rounded to 2 decimals; `toMinorUnits()` converts safely to integer minor units for Stripe) without storing card details.
- **`contactMessages`**: Contact inquiry records defaulting status to `New`.
- **`stripeWebhookEvents`**: Future webhook idempotency tracking keyed uniquely on `stripeEventId`.

---

## Database Indexes

Initialized idempotently on startup via `ensureDatabaseCollectionsAndIndexes()` in `src/config/dbIndexes.js`:

- `users`: Unique index on `email` (`users_email_unique`, Better Auth compatible), index on `role`.
- `equipment`: Indexes on `ownerId`, `status`, `category`, `location`, `rentalPrice`, `createdAt`, plus text index (`name`, `category`, `location`).
- `bookings`: Indexes on `customerId`, `ownerId`, `equipmentId`, `bookingStatus`, `paymentStatus`, `createdAt`, and availability query index `(equipmentId, bookingStatus, startDate, endDate)`.
- `favorites`: Unique compound index on `(userId, equipmentId)` and `(userId, createdAt)`.
- `payments`: Indexes on `bookingId`, `customerId`, `ownerId`, `status`, plus unique partial string indexes on `stripeCheckoutSessionId` and `stripePaymentIntentId`.
- `contactMessages`: Indexes on `createdAt` and `status`.
- `stripeWebhookEvents`: Unique index on `stripeEventId`.

---

## API Health & Readiness Endpoints

- **Root Endpoint (`GET /`)**: HTTP `200` — `{ "success": true, "message": "Welcome to GearNest API" }`
- **Liveness Endpoint (`GET /api/health`)**: HTTP `200` confirming the Express process is running independently of database state.
- **Readiness Endpoint (`GET /api/health/ready`)**:
  - Connected: HTTP `200` `{ "success": true, "message": "GearNest database is ready", "data": { "service": "GearNest API", "database": "connected" } }`
  - Unavailable: HTTP `503` `{ "success": false, "message": "GearNest database is unavailable", "error": null }`

---

## Authentication & Frontend Integration (Better Auth + JWT)

Authentication is powered by Better Auth (`src/config/auth.js`) backed by `@better-auth/mongo-adapter` (`usePlural: true`, sharing the `users` collection cleanly with `sessions`, `accounts`, `verifications`, and `jwks` managed by Better Auth) and the official `jwt()` plugin (`better-auth/plugins`).

- **Express Handler Order:** `/api/auth/*splat` is mounted via `toNodeHandler(auth)` in `src/app.js` **after** `cors(corsOptions)` and **strictly before** `express.json()` so Better Auth receives untouched request streams.
- **Better Auth Base URL & Path:** Configured from `BETTER_AUTH_URL` (local default: `http://localhost:5000`), mounted at `/api/auth`.
- **Token Issuer & Audience:** Both `issuer` and `audience` match the configured `BETTER_AUTH_URL`.
- **Roles & Signup Policy:** User `role` (`Customer`, `Owner`, `Admin`) is configured with `input: false` and enforced unconditionally via `databaseHooks.user.create.before` so every public email signup and Google login starts with `role: "Customer"`. Email verification and password reset flows are disabled per platform requirements.
- **Password Complexity:** Minimum `6` characters, at least `1` uppercase letter (`A-Z`), and at least `1` lowercase letter (`a-z`), enforced server-side in Better Auth `hooks.before` on `/api/auth/sign-up/email`.
- **Auth Rate Limiting:** Better Auth rate-limiting protects `/api/auth/sign-in/email`, `/api/auth/sign-up/email`, and `/api/auth/sign-in/social` with sensible brute-force thresholds without blocking normal testing.

### Authentication Endpoints

| Action | Method & Path | Notes |
| --- | --- | --- |
| Email Registration | `POST /api/auth/sign-up/email` | Requires `name`, `email`, `password` (>= 6 chars, upper + lower); optional `image` HTTP/HTTPS URL. Always assigns `role: "Customer"`. |
| Email Login | `POST /api/auth/sign-in/email` | Authenticates user and sets secure session cookie. |
| Google Social Login | `POST /api/auth/sign-in/social` | Configured when `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET` are set. |
| Get Active Session | `GET /api/auth/get-session` | Returns authenticated session and user (including `role`). |
| Logout | `POST /api/auth/sign-out` | Clears active session and cookie. |
| Mint Signed JWT | `GET /api/auth/token` | Returns a signed JWT (`15m` TTL) for an authenticated session via the Better Auth JWT plugin. |
| Public Verification Keys | `GET /api/auth/jwks` | Exposes public JWK set (private keys are never exposed). |

### Google OAuth Redirect / Callback URI

Configure the authorized redirect URI in Google Cloud Console as:

- **Development:** `http://localhost:5000/api/auth/callback/google`
- **Production:** `${BETTER_AUTH_URL}/api/auth/callback/google` (e.g., `https://api.yourdomain.com/api/auth/callback/google`)

### Required Frontend Client Configuration (`better-auth/react`)

- Configure the Next.js Better Auth client (`createAuthClient`) with `baseURL: process.env.NEXT_PUBLIC_API_BASE_URL`, `basePath: "/api/auth"`, `plugins: [jwtClient()]`, and `fetchOptions: { credentials: "include" }`.
- Ensure the frontend origin is included in `CLIENT_URL` and `CORS_ORIGINS` (exact origin URLs; never combine `"*"` with `credentials: true`).
- In HTTPS production deployments where frontend and backend use separate hostnames, cross-origin cookies automatically use `SameSite=None; Secure; HttpOnly`; same-site/local setups retain `SameSite=Lax; HttpOnly`.
- Retrieve JWT bearer tokens strictly via the official Better Auth client (`authClient.token()`), never by signing tokens in client code.

---

## JWT Verification & Role-Based Access Control (Commit 04)

Protected API routes verify Better Auth JWTs cryptographically using `jose` (`createRemoteJWKSet` + `jwtVerify`) against the Better Auth JWKS endpoint and resolve the user's **current** database role from MongoDB (`users`) on every request.

- **Authorization Header:** Clients send `Authorization: Bearer <ACCESS_TOKEN>`.
- **JWKS & Key Rotation:** `src/config/jwks.js` reuses a cached `createRemoteJWKSet()` resolver targeting `BETTER_AUTH_JWKS_URL` (default: `${BETTER_AUTH_URL}/api/auth/jwks`). Unknown or rotated `kid` keys trigger automatic keyset refresh; if JWKS is unavailable, verification fails closed (`503`) and never accepts unverified tokens.
- **Claims & Algorithm Validation:** Validates cryptographic signature, `iss` (`BETTER_AUTH_ISSUER`), `aud` (`BETTER_AUTH_AUDIENCE`), `exp`, and required `sub`, permitting only asymmetric algorithms (`EdDSA`, `ES256`, `RS256`) and rejecting `alg=none` or `HS256`.
- **Fresh Database User Lookup:** `verifyToken` queries MongoDB `users` (supporting both Better Auth `ObjectId` and string identifiers without assuming `_id` format) to verify account existence, reject disabled/suspended accounts, and read the latest `role` directly from MongoDB so stale JWTs cannot retain revoked privileges.

### Middleware Execution Order & Exports

1. `verifyToken` (`src/middleware/verifyToken.js`) — validates Bearer JWT + current MongoDB user and attaches `req.auth` and sanitized `req.user` (`{ id, name, email, role, image }`, zero password hashes).
2. `verifyRenter` (`src/middleware/verifyRoles.js`) — authorizes canonical database role `Customer`.
3. `verifyOwner` (`src/middleware/verifyRoles.js`) — authorizes canonical database role `Owner`.
4. `verifyAdmin` (`src/middleware/verifyRoles.js`) — authorizes canonical database role `Admin`.

```js
// Protected route execution chain
router.get("/owner-data", verifyToken, verifyOwner, controller);
```

### Protected Identity Endpoint

- **`GET /api/protected/me`** (`verifyToken`): Returns HTTP `200` with `{ "success": true, "data": { "id", "name", "email", "role", "image" } }` for authenticated callers.

### Standardized Auth Error Responses

- **HTTP `401` Unauthorized:**
  - Missing/empty token: `{ "success": false, "message": "Authentication required" }`
  - Malformed/invalid/wrong-claim token: `{ "success": false, "message": "Invalid or expired access token" }`
  - Expired token: `{ "success": false, "message": "Your session has expired. Please log in again." }`
  - Deleted/missing DB user: `{ "success": false, "message": "Authenticated user not found" }`
- **HTTP `403` Forbidden:**
  - Missing/invalid DB role: `{ "success": false, "message": "Your account does not have a valid role" }`
  - Role denied (`verifyRenter` / `verifyOwner` / `verifyAdmin`): `{ "success": false, "message": "Customer access required" }` (or `"Owner access required"` / `"Admin access required"`)

### Resource Ownership Security Rules

- Role authorization alone does not establish resource access. Controllers must verify actual database ownership against verified `req.user.id` (e.g., via `isResourceOwner(record.ownerId, req)`) and must never trust `req.body.userId`, `req.body.ownerId`, or `req.query.ownerId` for authorization.

---

## User Profile & Admin User Governance APIs (Commit 05)

All routes below require a valid Better Auth Bearer token (`Authorization: Bearer <ACCESS_TOKEN>`) verified via `verifyToken`. Administrative endpoints additionally enforce `verifyAdmin` (`role === "Admin"`). Never exposes password hashes, session tokens, or OAuth secrets.

| Method & Endpoint | Middleware | Purpose |
| --- | --- | --- |
| `GET /api/users/me` | `verifyToken` | Retrieve authenticated user's profile (`id` sourced from `req.user.id`). |
| `PATCH /api/users/me` | `verifyToken` | Update allowlisted profile fields (`name`, `image` / `photoURL`, `phone`, `address`). Strictly rejects `role`, `email`, `emailVerified`, `password`, `userId`, or unknown fields (`400`). |
| `GET /api/admin/users` | `verifyToken`, `verifyAdmin` | Search (`name` / `email` escaped regex), filter (`role`: `all` \| `Customer` \| `Owner` \| `Admin`), sort (`newest`, `oldest`, `name_asc`, `name_desc`), and paginate (`page`, `limit` max `50`) users. |
| `GET /api/admin/users/:id` | `verifyToken`, `verifyAdmin` | Retrieve safe profile details and optional `accountStatus` for a selected user (`404` when absent). |
| `PATCH /api/admin/users/:id/role` | `verifyToken`, `verifyAdmin` | Update a user's canonical role (`Customer`, `Owner`, `Admin`). Prevents self-role changes and immediately enforces the new role on subsequent `verifyToken` checks. |

---

## Equipment Management & Image Upload APIs (Commit 06)

- **Allowed Categories:** `Construction Equipment`, `Photography Equipment`, `Vehicles & Transportation`, `Agriculture Equipment`, `Electronics`, `Event Equipment`
- **Allowed Rental Types:** `Daily`, `Weekly`, `Monthly`
- **Approval Statuses:** `Pending` (forced default on Owner creation), `Approved` (eligible for public catalog), `Rejected`
- **ImgBB Environment Variable:** Configure `IMGBB_API_KEY` solely in `server/.env`; never expose it to the frontend or API responses.

| Method & Endpoint | Access / Middleware | Description |
| --- | --- | --- |
| `GET /api/equipment` | Public | Dynamic search, filter, sort & pagination across `Approved` equipment only (see query specification below). |
| `GET /api/equipment/featured` | Public | Returns newest `Approved` items via MongoDB `.limit(safeLimit)` (default `6`, maximum `12`). |
| `GET /api/equipment/my` | `verifyToken`, `verifyOwner` | Lists the authenticated Owner's `Pending`, `Approved`, and `Rejected` listings (`page`, `limit`, optional `status`) plus status counts. |
| `POST /api/equipment` | `verifyToken`, `verifyOwner` | Submits new equipment; validates all 12 fields (`rentalPrice > 0`, integer `availableQuantity >= 1`, HTTP/HTTPS `image`), assigns `ownerId` from `req.user.id`, forces `status: "Pending"`, and rejects spoofed `ownerId`/`status`. |
| `GET /api/equipment/:id` | `verifyToken` | Returns item details with safe owner fields. Customers and other users view `Approved` items only (`404` otherwise); Owners can inspect their own `Pending`/`Rejected` items. Admin full review is scheduled for Commit 13. |
| `PATCH /api/equipment/:id` | `verifyToken`, `verifyOwner` | Updates editable fields of equipment owned by `req.user.id` (`403` cross-owner). Rejects attempts to change `ownerId`, `status`, or unknown fields (`400`). |
| `DELETE /api/equipment/:id` | `verifyToken`, `verifyOwner` | Deletes unbooked equipment owned by `req.user.id` (`403` cross-owner) and removes orphaned favorites. Blocks deletion (`409`) if associated bookings or payments exist. |
| `POST /api/uploads/equipment-image` | `verifyToken`, `verifyOwner`, `upload` | Accepts `multipart/form-data` (`image`, max `5 MB`, JPG/JPEG/PNG/WEBP verified by MIME, extension, and binary file signature) and proxies upload to ImgBB returning `{ url, deleteUrl }`. |

### Public Catalog Search, Filtering, Sorting & Pagination (`GET /api/equipment` — Commit 07)

Returns `Approved` equipment only (client `status` parameters cannot override public approval visibility) and executes search, filters, sorting, and pagination directly against MongoDB:

- **`search`:** Case-insensitive regex-escaped substring match (`$or`) across `name`, `title` (if present), `location`, and `category` (max `120` chars). Note: unanchored `$regex` preserves partial substring matching cleanly while the collection retains compound `status`/filter/sort indexes and the `equipment_search_text_idx` text index.
- **`category`:** `all` (or omitted) or one of the 6 canonical categories (`400 Invalid equipment category` otherwise).
- **`rentalType`:** `all` (or omitted) or `Daily` | `Weekly` | `Monthly` (`400 Invalid rental type` otherwise).
- **`minPrice`, `maxPrice`:** Non-negative finite numeric bounds (`$gte` / `$lte`, rejects `NaN`, `Infinity`, negatives, and `minPrice > maxPrice` with `400 Invalid price range`).
- **`availability`:** `all` (or omitted) | `available` (`availableQuantity > 0`) | `unavailable` (`availableQuantity <= 0` or missing/null legacy quantity; `400 Invalid availability filter` otherwise).
- **`sort`:** `newest` (default, `{ createdAt: -1, _id: -1 }`), `price_asc` (`{ rentalPrice: 1, _id: 1 }`), `price_desc` (`{ rentalPrice: -1, _id: 1 }`), `featured` (`{ createdAt: -1, _id: -1 }` fallback; `400 Invalid sorting option` otherwise).
- **`page`, `limit`:** Positive integers defaulting to `page=1`, `limit=9`, maximum `limit=50` (`400 Invalid pagination parameters` otherwise). Returns `{ success: true, message, data, pagination: { currentPage, limit, totalItems, totalPages } }` (`"No matching equipment found"` when `data` is empty).

Example queries:

```text
GET /api/equipment?search=excavator
GET /api/equipment?category=Construction%20Equipment
GET /api/equipment?rentalType=Daily
GET /api/equipment?minPrice=1000&maxPrice=10000
GET /api/equipment?availability=available
GET /api/equipment?sort=price_asc
GET /api/equipment?page=2&limit=9
GET /api/equipment?search=excavator&category=Construction%20Equipment&rentalType=Daily&minPrice=3000&maxPrice=15000&availability=available&sort=price_asc&page=1&limit=9
```

---

## Development, Testing & Production Scripts

```bash
# Development server (auto-reload with nodemon; requires valid MONGODB_URI, DB_NAME & BETTER_AUTH_SECRET in .env)
npm run dev

# Production server start
npm start

# Run automated verification test suites (node:test)
npm test

# Static JavaScript syntax validation across src/ and tests/
npm run check
```
