# GearNest API

## Project Overview

GearNest API powers the backend REST services for **GearNest — Equipment Rental Platform**, connecting equipment owners and customers through an organized marketplace.

- **Implemented in Commit 01–02:** Express.js application bootstrap, environment validation, restricted credentialed CORS, Helmet security headers, Morgan HTTP logging, singleton MongoDB Node.js Driver connection (`connectDB`, `getDB`, `getClient`, `closeDB`), collection architecture (`users`, `equipment`, `bookings`, `favorites`, `payments`, `contactMessages`, `stripeWebhookEvents`), idempotent database index initialization, constants/validators, centralized error handling (including MongoDB duplicate-key/availability errors), liveness (`GET /api/health`), and readiness (`GET /api/health/ready`) endpoints.
- **Planned in subsequent commits:** Better Auth + JWT verification (Commit 03), role-based authorization middleware (Commit 04), Equipment/Favorites/Booking/Owner/Admin APIs, ImgBB image upload proxying, Stripe Checkout & webhook processing (Commit 10+), and Contact message endpoints.

---

## Technology Stack

### Implemented
- **Runtime:** Node.js (ES Modules)
- **Framework:** Express.js (`^5.1.0`)
- **Language:** JavaScript
- **Database & Driver:** MongoDB via Official MongoDB Node.js Driver (`^7.x`)
- **Security & Middleware:** `helmet`, `cors`, `morgan`, `dotenv`

### Planned Integrations
- **Authentication & Sessions:** Better Auth + MongoDB Adapter (Commit 03)
- **Authorization:** JWT verification & role-based middleware (Commits 03–04)
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

## Development & Production Scripts

```bash
# Development server (auto-reload with nodemon; requires valid MONGODB_URI & DB_NAME in .env)
npm run dev

# Production server start
npm start

# Static JavaScript syntax validation across src/
npm run check
```
