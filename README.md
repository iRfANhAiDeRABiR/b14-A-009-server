# GearNest — Equipment Rental Platform API

## 1. Project Overview

**GearNest — Equipment Rental Platform API** is the production-oriented REST backend built with Express.js and MongoDB for the GearNest marketplace, enabling equipment Owners to list rental assets, Customers to search, favorite, reserve, and pay for rentals via Stripe Checkout, and Admins to moderate equipment, govern roles, monitor transactions, and analyze platform revenue.

---

## 2. Main Features

- **Better Auth Authentication:** Shared MongoDB-backed authentication (`/api/auth/*`) supporting email/password registration, email/password login, conditional Google OAuth login, logout, persistent sessions, and JWT issuance.
- **Role-Based Access Control (RBAC) & JWT Verification:** Cryptographic JWKS verification (`EdDSA`, `ES256`, `RS256`) paired with fresh MongoDB user lookups and four guards: `verifyToken`, `verifyRenter` (`Customer`), `verifyOwner` (`Owner`), and `verifyAdmin` (`Admin`).
- **User & Profile Management:** Authenticated user self-profile retrieval/update (`GET/PATCH /api/users/me`) and Admin user listing, inspection, and controlled role management (`GET /api/admin/users`, `GET /api/admin/users/:id`, `PATCH /api/admin/users/:id/role`).
- **Equipment Management & ImgBB Upload:** Owner equipment submission (`Pending` by default), listing, update, booking-safe deletion, server-side ImgBB multipart image proxying (`POST /api/uploads/equipment-image`), public approved catalog listing, and homepage featured limit (`6` items).
- **Server-Side Search, Filtering, Sorting & Pagination:** Direct MongoDB querying (`search`, `category`, `rentalType`, `minPrice`, `maxPrice`, `availability`, `sort`, `page`, `limit`) limited strictly to `Approved` non-archived listings.
- **Customer Favorites:** Customer-isolated wishlist persistence in `favorites` with duplicate key protection (`userId + equipmentId`) and `$lookup` hydration.
- **Rental Booking & Availability System:** UTC inclusive date range validation, Daily/Weekly/Monthly server-side pricing, overlap quantity checking across `bookings` + active unexpired `bookingIntents`, and MongoDB multi-document transaction reservations.
- **Stripe Checkout & Verified Webhooks:** Server-derived Stripe Hosted Checkout sessions (`POST /api/payments/create-checkout-session`), binary-raw webhook verification (`POST /api/payments/webhook`), atomic MongoDB finalization (`bookings` + `payments` + `stripeWebhookEvents`), and read-only session verification (`GET /api/payments/session/:sessionId`).
- **Rental Management APIs:** Role-isolated rental listing and details for Customers (`GET /api/bookings/my`, `GET /api/bookings/:id`), Owners (`GET /api/owner/rentals`, `GET /api/owner/rentals/:id`), and Admins (`GET /api/admin/rentals`, `GET /api/admin/rentals/:id`).
- **Admin Equipment Moderation & Management:** Platform-wide equipment search/filter/pagination, approve/reject endpoints with audit trail (`approvalHistory`, `reviewedBy`, `reviewedAt`, `rejectionReason`), catalog editing, and history-safe archival (`isDeleted: true`).
- **Admin & Owner Dashboard Analytics:** MongoDB `$facet`/`$group` aggregation pipelines reporting all-time KPIs, deduplicated paid revenue/earnings, UTC calendar-month trends (`3m`, `6m`, `12m`), approval breakdowns, and Owner top-5 equipment performance.
- **Public Contact Inquiry API:** Rate-limited, validated contact form persistence (`POST /api/contact` -> `contactMessages` collection, default `status: "New"`).
- **Optional Operational Automation:** Idempotent UTC booking completion cron job (`node-cron`) for elapsed paid bookings and non-blocking optional SMTP completion notifications (`nodemailer`).

---

## 3. Technology Stack

- **Runtime:** Node.js (`>= 18.18.0`, ES Modules)
- **Framework:** Express.js (`express`)
- **Language:** JavaScript
- **Database:** MongoDB via Official MongoDB Node.js Driver (`mongodb`)
- **Authentication & Tokens:** Better Auth (`better-auth`) + MongoDB Adapter (`@better-auth/mongo-adapter`) + JWT (`jose` & Better Auth `jwt()` plugin)
- **Payments:** Stripe (`stripe`)
- **Image Upload & Hosting:** Multer (`multer`) + server-side ImgBB API integration
- **Scheduling & Email (Optional Features):** `node-cron` + `nodemailer`
- **Security & Middleware:** `helmet`, `cors`, custom sliding-window rate limiter, `morgan`, `dotenv`

---

## 4. Installed npm Packages

Packages listed directly in `package.json`:

| Package | Version Range | Purpose |
| --- | --- | --- |
| `@better-auth/mongo-adapter` | `^1.7.27` | Connects Better Auth to the shared MongoDB database (`users`, `sessions`, `accounts`, `verifications`, `jwks`) |
| `better-auth` | `^1.7.27` | Handles registration, email/password & Google OAuth login, sessions, and JWT/JWKS plugin endpoints |
| `cors` | `^2.8.6` | Enforces exact origin allowlists with `credentials: true` |
| `dotenv` | `^16.5.0` | Loads environment variables from `.env` in local development |
| `express` | `^5.1.0` | Core HTTP server and modular REST API routing |
| `helmet` | `^8.1.0` | Sets defensive HTTP security headers |
| `jose` | `^6.2.18` | Verifies asymmetric Better Auth JWT signatures against remote JWKS keys |
| `mongodb` | `^7.9.1` | Official MongoDB driver for connection pooling, queries, indexes, aggregations, and transactions |
| `morgan` | `^1.10.0` | Structured HTTP request logging (`dev` / `combined`) |
| `multer` | `^2.5.0` | Parses `multipart/form-data` image uploads into memory buffers with size/file caps |
| `node-cron` | `^4.6.0` | Schedules the optional daily UTC completed-rental sweep job |
| `nodemailer` | `^10.6.1` | Optional SMTP client for automated completion notifications when `MAIL_*` is configured |
| `stripe` | `^23.2.0` | Stripe Checkout Session creation, retrieval, currency checks, and webhook signature construction |
| `nodemon` (devDependency) | `^3.1.9` | Hot-reloads local development server (`npm run dev`) |

---

## 5. Server Repository

- **GitHub Repository:** https://github.com/iRfANhAiDeRABiR/b14-A-009-server.git

---

## 6. Live API URL

- **Status:** Not deployed yet.
- Configure your production host domain in `BETTER_AUTH_URL`, `BETTER_AUTH_JWKS_URL`, `BETTER_AUTH_ISSUER`, and `BETTER_AUTH_AUDIENCE`, then verify `/api/health` and `/api/health/ready` after deployment.

---

## 7. Installation

```bash
git clone https://github.com/iRfANhAiDeRABiR/b14-A-009-server.git
cd b14-A-009-server
npm install
```

---

## 8. Environment Setup

Copy `.env.example` to `.env` before starting the server locally. Never commit `.env` or real secrets.

```bash
cp .env.example .env
```

Every variable actually read by `server/src/` (`env.js`, `authHelpers.js`, `stripe.js`, `imageUpload.service.js`, `mailer.js`, `seedAdmin.js`):

| Variable | Required? | Purpose & Notes |
| --- | --- | --- |
| `NODE_ENV` | Recommended | `development`, `production`, or `test` |
| `PORT` | Recommended | Dynamic HTTP listener port (default `5000`; set automatically by cloud hosts) |
| `JSON_BODY_LIMIT` | Optional | Express JSON/URL-encoded body limit (default `100kb`) |
| `CLIENT_URL` | Required for frontend/Stripe | Exact frontend origin (must use `https://` when `NODE_ENV=production`, default `http://localhost:3000` in dev) |
| `CORS_ORIGINS` | Required for CORS | Comma-separated exact allowed frontend origins (wildcard `*` forbidden with credentials) |
| `MONGODB_URI` | Required | MongoDB Atlas / MongoDB connection string (`mongodb://` or `mongodb+srv://`) |
| `DB_NAME` | Required | Target database name (e.g., `gearnest`) |
| `MONGODB_TRANSACTIONS` | Optional | Multi-document transaction flag (default `true`; replica set required for bookings/webhooks) |
| `DB_CONNECT_TIMEOUT_MS` | Optional | Initial MongoDB connect timeout ms (default `10000`) |
| `DB_SERVER_SELECTION_TIMEOUT_MS` | Optional | Server selection timeout ms (default `5000`) |
| `DB_SOCKET_TIMEOUT_MS` | Optional | Socket timeout ms (default `20000`) |
| `BETTER_AUTH_SECRET` | Required | Signing secret (`>= 32` chars recommended/required in production) |
| `BETTER_AUTH_URL` | Required in prod | Public base URL of this API server (default `http://localhost:${PORT}` in dev) |
| `BETTER_AUTH_JWKS_URL` | Optional | Overrides `${BETTER_AUTH_URL}/api/auth/jwks` |
| `BETTER_AUTH_ISSUER` | Optional | Overrides expected JWT `iss` (defaults to `BETTER_AUTH_URL`) |
| `BETTER_AUTH_AUDIENCE` | Optional | Overrides expected JWT `aud` (defaults to `BETTER_AUTH_URL`) |
| `AUTH_RATE_LIMIT` | Optional | Set `false` to disable Better Auth built-in limiter locally if needed |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional (Google OAuth) | Enables Google OAuth when both are set; skipped cleanly when omitted |
| `STRIPE_SECRET_KEY` | Required for Checkout | Server Stripe key (`sk_test_...` / `sk_live_...` / `rk_...`) |
| `STRIPE_WEBHOOK_SECRET` | Required for Webhooks | Stripe webhook endpoint signing secret (`whsec_...`) |
| `STRIPE_CURRENCY` | Required for Checkout | 3-letter ISO currency (e.g., `bdt`); validated against connected Stripe account |
| `STRIPE_CHECKOUT_EXPIRE_MINUTES` | Optional | Checkout session expiration in `[30..1440]` minutes (default `30`) |
| `BOOKING_HOLD_MINUTES` | Optional | Pending reservation hold duration in `[1..1440]` minutes (default `10`) |
| `IMGBB_API_KEY` | Required for Image Upload | ImgBB server-side upload key; kept strictly server-side |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Bootstrap CLI only | Used once by `npm run seed:admin` to provision initial Admin safely |
| `ENABLE_BOOKING_CRON` | Optional | Set `false` to disable automatic booking completion scheduler (default `true`, off in tests) |
| `BOOKING_COMPLETION_CRON` | Optional | UTC cron expression (default `5 0 * * *`) |
| `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM` | Optional (SMTP) | Enables completion email notifications; skipped gracefully without blocking APIs when omitted |

---

## 9. Database Configuration

- **Singleton Pool:** `src/config/db.js` shares one `MongoClient` (`maxPoolSize: 20`, `minPoolSize: 2`, Stable API v1 `strict: false` for `$text` queries) across Better Auth and all REST modules.
- **Core Collections:** `users`, `equipment`, `bookings`, `bookingIntents`, `favorites`, `payments`, `contactMessages`, `stripeWebhookEvents` (plus Better Auth auth collections `sessions`, `accounts`, `verifications`, `jwks` sharing `users` via `usePlural: true`).
- **Monetary & Date Convention:** Prices and payment `amount` values are stored rounded to 2 decimals in `DEFAULT_CURRENCY` (`BDT`), with integer `amountMinor` stored alongside `payments`; calendar booking `startDate` / `endDate` dates are normalized UTC midnights (`YYYY-MM-DDT00:00:00.000Z`).
- **Indexes (`src/config/dbIndexes.js`):**
  - `users`: unique `{ email: 1 }`, `{ role: 1 }`, sparse `{ id: 1 }`.
  - `equipment`: `{ ownerId: 1 }`, `{ status: 1 }`, `{ category: 1 }`, `{ location: 1 }`, `{ rentalPrice: 1 }`, `{ createdAt: -1 }`, `{ rentalType: 1 }`, `{ availableQuantity: 1 }`, compound catalog/moderation/availability indexes, and text index `{ name: "text", category: "text", location: "text" }`.
  - `bookings`: `{ customerId: 1 }`, `{ ownerId: 1 }`, `{ equipmentId: 1 }`, `{ bookingStatus: 1 }`, `{ paymentStatus: 1 }`, `{ createdAt: -1 }`, `{ startDate: 1, _id: -1 }`, `{ endDate: 1, _id: -1 }`, compound customer/owner/availability indexes, and partial unique `{ bookingIntentId: 1 }`.
  - `bookingIntents`: `{ customerId: 1, createdAt: -1 }`, availability index `{ equipmentId: 1, status: 1, expiresAt: 1, startDate: 1, endDate: 1 }`, TTL `{ expiresAt: 1 }` (`expireAfterSeconds: 0`), and partial unique `{ stripeCheckoutSessionId: 1 }`.
  - `favorites`: unique `{ userId: 1, equipmentId: 1 }`, `{ userId: 1, createdAt: -1 }`.
  - `payments`: `{ bookingId: 1 }`, `{ customerId: 1 }`, `{ ownerId: 1 }`, `{ status: 1 }`, `{ status: 1, paidAt: -1 }`, `{ ownerId: 1, status: 1, paidAt: -1 }`, `{ status: 1, createdAt: -1 }`, and partial unique indexes on `{ stripeCheckoutSessionId: 1 }` and `{ stripePaymentIntentId: 1 }`.
  - `stripeWebhookEvents`: unique `{ stripeEventId: 1 }`.
  - `contactMessages`: `{ createdAt: -1 }`, `{ status: 1 }`.

---

## 10. Authentication

- Mounted on `/api/auth/*splat` via `toNodeHandler(auth)` in `src/app.js` **strictly before** `express.json()`.
- Password registration enforces `>= 6` characters, `>= 1` uppercase letter, and `>= 1` lowercase letter.
- Email verification and password reset flows are intentionally omitted per assignment rules.
- Public email registrations and Google OAuth logins unconditionally initialize `role: "Customer"` (`input: false` + database hook).
- Better Auth `jwt()` plugin signs `15m` JWTs exposed at `GET /api/auth/token`, verified against public keys at `GET /api/auth/jwks`.
- Cross-origin cookies switch dynamically to `SameSite=None; Secure; HttpOnly` only when running over HTTPS with cross-site frontend origins.

---

## 11. Roles and Authorization

Supported canonical roles: **`Customer`**, **`Owner`**, **`Admin`**.

Required middlewares:

1. **`verifyToken`** (`src/middleware/verifyToken.js`): Validates Bearer JWT signature/JWKS/`iss`/`aud`/`exp`/`sub`, looks up the user in MongoDB `users` (supporting both ObjectId and Better Auth string IDs), rejects deleted/banned/disabled accounts, and attaches the authoritative database role to `req.user` (preventing stale JWT privilege retention).
2. **`verifyRenter`** (`src/middleware/verifyRoles.js`): Authorizes canonical database role `Customer`.
3. **`verifyOwner`** (`src/middleware/verifyRoles.js`): Authorizes canonical database role `Owner`.
4. **`verifyAdmin`** (`src/middleware/verifyRoles.js`): Authorizes canonical database role `Admin`.

Controllers also enforce resource ownership separately (`req.user.id`), ignoring client-supplied `ownerId`, `customerId`, or `userId`.

---

## 12. API Documentation

All JSON endpoints follow `{ "success": boolean, "message": string, "data"?: ..., "pagination"?: ..., "error"?: ... }`.

### System & Health
| Method | Endpoint | Auth | Response |
| --- | --- | --- | --- |
| `GET` | `/` | Public | `200`: `{ success: true, message: "Welcome to GearNest API" }` |
| `GET` | `/api/health` | Public | `200`: `{ success: true, message, data: { service, status: "healthy", environment } }` |
| `GET` | `/api/health/ready` | Public | `200` if MongoDB ping succeeds (`database: "connected"`), `503` otherwise |

### Authentication (Better Auth `/api/auth/*`)
| Method | Endpoint | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/sign-up/email` | Public | Email/password signup (`Customer` role forced) |
| `POST` | `/api/auth/sign-in/email` | Public | Email/password session login |
| `POST` | `/api/auth/sign-in/social` | Public | Google OAuth initiation (when `GOOGLE_*` configured) |
| `GET` | `/api/auth/callback/google` | Public (Google redirect) | Google OAuth callback handler |
| `GET` | `/api/auth/get-session` | Session cookie | Returns active session & user |
| `POST` | `/api/auth/sign-out` | Session cookie | Ends active session |
| `GET` | `/api/auth/token` | Session cookie | Issues signed `15m` JWT access token |
| `GET` | `/api/auth/jwks` | Public | Returns public verification keys (JWK Set) |

### Users & Profile
| Method | Endpoint | Auth / Role | Request / Response |
| --- | --- | --- | --- |
| `GET` | `/api/protected/me` | `verifyToken` | Safe authenticated user claims (`id`, `name`, `email`, `role`, `image`) |
| `GET` | `/api/users/me` | `verifyToken` | Full sanitized user profile (`phone`, `address`, `role`, etc.) |
| `PATCH` | `/api/users/me` | `verifyToken` | Updates `name`, `image`/`photoURL`, `phone`, `address` (`400` on restricted fields like `role`) |

### Equipment & Uploads
| Method | Endpoint | Auth / Role | Query / Body / Response |
| --- | --- | --- | --- |
| `GET` | `/api/equipment` | Public | `?search=&category=&rentalType=&minPrice=&maxPrice=&availability=&sort=&page=1&limit=9` (`Approved` only) |
| `GET` | `/api/equipment/featured` | Public | `?limit=6` (max `12`), newest `Approved` items via MongoDB `.limit()` |
| `GET` | `/api/equipment/recent` | Public | `?limit=4` (max `12`), newest `Approved` recently added items via MongoDB `.limit()` |
| `GET` | `/api/equipment/my` | `verifyToken`, `verifyOwner` | `?status=&page=1&limit=10`, Owner's own listings across all statuses + summary |
| `POST` | `/api/equipment` | `verifyToken`, `verifyOwner` | Submits 12-field listing (`status: "Pending"` forced; `ownerId` from `req.user.id`) |
| `GET` | `/api/equipment/:id` | `verifyToken` | Public-approved or owner's own item details (`404` for unauthorized unapproved items) |
| `PATCH` | `/api/equipment/:id` | `verifyToken`, `verifyOwner` | Owner updates own editable catalog fields (`403` cross-owner, `400` restricted fields) |
| `DELETE` | `/api/equipment/:id` | `verifyToken`, `verifyOwner` | Deletes unbooked owned listing (`409` when linked to bookings/payments) |
| `POST` | `/api/uploads/equipment-image` | `verifyToken`, `verifyOwner` | `multipart/form-data` (`image`, `<= 5 MB`, JPG/JPEG/PNG/WEBP magic-byte check) -> `{ url, deleteUrl }` |

### Favorites
| Method | Endpoint | Auth / Role | Request / Response |
| --- | --- | --- | --- |
| `POST` | `/api/favorites` | `verifyToken`, `verifyRenter` | `{ equipmentId }` -> `201` (or `200` if already saved; `Approved` only) |
| `GET` | `/api/favorites` | `verifyToken`, `verifyRenter` | `?page=&limit=`, Customer's hydrated wishlist (`$lookup`) |
| `GET` | `/api/favorites/:equipmentId/status` | `verifyToken`, `verifyRenter` | `200` with `{ equipmentId, isFavorite }` |
| `DELETE` | `/api/favorites/:equipmentId` | `verifyToken`, `verifyRenter` | `200` removing Customer's favorite (`404` if missing) |

### Bookings
| Method | Endpoint | Auth / Role | Query / Body / Response |
| --- | --- | --- | --- |
| `POST` | `/api/bookings/check-availability` | `verifyToken`, `verifyRenter` | `{ equipmentId, startDate, endDate, quantity }` -> `{ available, remainingQuantity, ... }` |
| `POST` | `/api/bookings` | `verifyToken`, `verifyRenter` | `{ equipmentId, startDate, endDate, quantity, contactNumber, deliveryAddress, additionalNotes? }` -> `201` reservation hold in `bookingIntents` |
| `GET` | `/api/bookings/my` | `verifyToken`, `verifyRenter` | `?search=&bookingStatus=&paymentStatus=&sort=&page=1&limit=10`, finalized Customer bookings |
| `GET` | `/api/bookings/:id` | `verifyToken`, `verifyRenter` | Single Customer booking + safe transaction summary (`404` cross-customer) |

### Payments & Stripe Webhooks
| Method | Endpoint | Auth / Role | Input / Response |
| --- | --- | --- | --- |
| `POST` | `/api/payments/create-checkout-session` | `verifyToken`, `verifyRenter` | `{ bookingIntentId }` -> `201` (`{ sessionId, checkoutUrl, expiresAt, currency, totalAmount }`) |
| `POST` | `/api/payments/webhook` | Stripe `stripe-signature` + raw `Buffer` | Verifies signature & Checkout Session, executes atomic finalization transaction |
| `GET` | `/api/payments/session/:sessionId` | `verifyToken`, `verifyRenter` | Read-only payment/booking status inspection for authenticated reservation owner |

### Owner Endpoints
| Method | Endpoint | Auth / Role | Query / Response |
| --- | --- | --- | --- |
| `GET` | `/api/owner/rentals` | `verifyToken`, `verifyOwner` | `?search=&bookingStatus=&paymentStatus=&equipmentId=&sort=&page=1&limit=10`, Owner-scoped rentals + summary |
| `GET` | `/api/owner/rentals/:id` | `verifyToken`, `verifyOwner` | Owner rental detail including delivery info (`404` cross-owner) |
| `GET` | `/api/owner/analytics` | `verifyToken`, `verifyOwner` | `?period=3m\|6m\|12m` (`12m` default), Owner KPIs, earnings/rental monthly trends, top 5 equipment performance & recent rentals |

### Admin Endpoints
| Method | Endpoint | Auth / Role | Query / Body / Response |
| --- | --- | --- | --- |
| `GET` | `/api/admin/users` | `verifyToken`, `verifyAdmin` | `?search=&role=&sort=&page=1&limit=10` (max `50`) |
| `GET` | `/api/admin/users/:id` | `verifyToken`, `verifyAdmin` | Single safe user profile (`404` when absent) |
| `PATCH` | `/api/admin/users/:id/role` | `verifyToken`, `verifyAdmin` | `{ role: "Customer" \| "Owner" \| "Admin" }` (blocks self-role modification) |
| `GET` | `/api/admin/equipment` | `verifyToken`, `verifyAdmin` | `?search=&category=&status=&sort=&page=1&limit=10` (max `50`), all statuses excluding soft-deleted |
| `GET` | `/api/admin/equipment/:id` | `verifyToken`, `verifyAdmin` | Detailed catalog item + `approvalHistory` audit trail |
| `PATCH` | `/api/admin/equipment/:id/approve` | `verifyToken`, `verifyAdmin` | Approves listing (`reviewedBy`, `reviewedAt`, clears `rejectionReason`) |
| `PATCH` | `/api/admin/equipment/:id/reject` | `verifyToken`, `verifyAdmin` | `{ reason }` / `{ rejectionReason }` (`3..500` chars) -> rejects listing with audit entry |
| `PATCH` | `/api/admin/equipment/:id` | `verifyToken`, `verifyAdmin` | Edits catalog metadata without altering `ownerId` or approval status |
| `DELETE` | `/api/admin/equipment/:id` | `verifyToken`, `verifyAdmin` | Hard deletes unbooked items or soft-archives (`isDeleted: true`) booked/paid items |
| `GET` | `/api/admin/rentals` | `verifyToken`, `verifyAdmin` | `?search=&bookingStatus=&paymentStatus=&equipmentId=&customerId=&ownerId=&sort=&page=1&limit=10` |
| `GET` | `/api/admin/rentals/:id` | `verifyToken`, `verifyAdmin` | Full safe Admin rental & Stripe reconciliation summary |
| `GET` | `/api/admin/analytics` | `verifyToken`, `verifyAdmin` | `?period=3m\|6m\|12m` (`12m` default), platform KPIs, UTC monthly series, approval breakdown & safe recent activity |

### Public Contact Endpoint
| Method | Endpoint | Auth / Rate Limit | Request / Response |
| --- | --- | --- | --- |
| `POST` | `/api/contact` | Public, 10 req / 15m per IP | `{ name, email, inquiryType, subject, message }` -> `201`: `{ success: true, message, data: { _id, inquiryType, status: "New", createdAt } }` |

---

## 13. Stripe Integration

- Configured in `src/config/stripe.js` and `src/services/stripeCheckout.service.js` / `src/services/stripeWebhook.service.js`.
- Amounts are recalculated from MongoDB equipment pricing in integer minor units (`src/utils/currency.js`).
- Before Checkout Session creation, `verifyStripeAccountCurrencyEligibility` verifies that the connected Stripe account country supports `STRIPE_CURRENCY` (e.g., `bdt`). **Important:** BDT (`bdt`) support depends on the connected Stripe account's country eligibility; unsupported combinations fail explicitly with `503 UNSUPPORTED_CURRENCY` rather than silently converting currency.
- **Verification Rule:** Payment confirmation happens **solely** inside `POST /api/payments/webhook` using verified Stripe signatures (`stripe-signature` + raw Buffer), live Stripe session retrieval, PaymentIntent verification, unique idempotency events (`stripeWebhookEvents`), and an atomic MongoDB multi-document transaction (`bookingFinalization.service.js`). Use Stripe test-mode (`sk_test_...` / Stripe CLI) keys when testing locally.

---

## 14. Development

```bash
npm run dev
```

Runs `nodemon --watch src src/server.js` using `.env` configuration.

---

## 15. Production

```bash
npm start
```

Runs `node src/server.js`, binds dynamically to `process.env.PORT`, configures `trust proxy = 1`, sets HTTP keep-alive/headers/request timeouts, disables `x-powered-by`, suppresses raw stack traces in error JSON responses, starts the optional UTC booking completion cron job (when `ENABLE_BOOKING_CRON` is not `false`), and gracefully drains HTTP & MongoDB connections on `SIGINT`/`SIGTERM`.

---

## 16. Deployment

To deploy the server (e.g., Render, Railway, Fly.io, DigitalOcean, or VPS):

1. Provision a transaction-capable **MongoDB Atlas replica set** (or self-hosted replica set — standalone MongoDB rejects multi-document booking/payment transactions with HTTP `503`).
2. Set production environment variables (`NODE_ENV=production`, `PORT`, HTTPS `CLIENT_URL`, exact `CORS_ORIGINS`, `MONGODB_URI`, `DB_NAME`, `BETTER_AUTH_SECRET`, HTTPS `BETTER_AUTH_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CURRENCY`, `IMGBB_API_KEY`, and optional `GOOGLE_*` / `MAIL_*`).
3. Configure Google Cloud Console authorized redirect URI: `${BETTER_AUTH_URL}/api/auth/callback/google` (if using Google OAuth).
4. Register Stripe production webhook endpoint `${BETTER_AUTH_URL}/api/payments/webhook` subscribing to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`.
5. Deploy using `npm start` and verify `GET /api/health` (`200`) and `GET /api/health/ready` (`200`).
6. Run the controlled initial Admin bootstrap once from a trusted server/CI environment (do not expose over HTTP and do not commit credentials):
   ```bash
   ADMIN_NAME="Platform Admin" ADMIN_EMAIL="admin@yourdomain.com" ADMIN_PASSWORD="<StrongPassword>" npm run seed:admin
   ```
   - `seedAdmin.js` uses Better Auth's `auth.api.signUpEmail()` mechanism to store properly hashed credentials, then sets `role: "Admin"` solely for that new user.
   - Re-running when the email already holds `Admin` is idempotent; attempting to bootstrap over an existing `Customer` or `Owner` account aborts safely without silent privilege escalation.

---

## 17. Testing

```bash
# Static syntax check across all files in src/ and tests/
npm run check

# Run full automated backend test suite (node:test)
npm test

# Controlled initial Admin bootstrap CLI (requires live MongoDB + BETTER_AUTH_SECRET)
npm run seed:admin
```

---

## 18. Known Limitations

- **Live Production Deployment:** This repository contains no live production deployment URL yet (`Not deployed yet.`).
- **Live Cloud Integration Verification:** While all automated test suites verify business logic, validation, JWKS/RBAC verification, MongoDB aggregations, Stripe Checkout/Webhook state machines, rate limiting, CORS, and optional cron/email behavior using isolated test doubles and in-memory HTTP servers, live MongoDB Atlas cluster execution (`.explain("executionStats")`), live ImgBB uploads, live Google OAuth browser consent, live Stripe test-mode charges against your connected account's `bdt` eligibility, and real SMTP delivery (`MAIL_*`) require real environment credentials to execute end-to-end.
- **Replica Set Dependency:** `POST /api/bookings` and `POST /api/payments/webhook` finalization require MongoDB multi-document transactions (replica set / MongoDB Atlas); standalone `mongod` instances intentionally return HTTP `503` rather than committing partial booking/payment state.
- **In-Memory API Rate Limiter:** `src/middleware/rateLimiter.js` uses per-process memory buckets (sufficient for single-instance deployment; multi-instance horizontal scaling should pair with reverse-proxy or shared Redis rate limiting).
