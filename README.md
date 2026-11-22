# GearNest API

## Project Overview

GearNest API powers the backend REST services for **GearNest — Equipment Rental Platform**, a marketplace where equipment owners list machinery and tools and customers browse, reserve, pay for, and manage rentals across dedicated dashboards.

This repository is being built incrementally:

- **Implemented in Commit 01:** Standalone Express.js application bootstrap, environment configuration (`dotenv`), restricted CORS policy, Helmet security headers, Morgan HTTP logging, request body size limits, centralized 404/error handling (including malformed JSON handling), root endpoint (`GET /`), and health check endpoint (`GET /api/health`).
- **Planned in subsequent commits:** MongoDB database connection (Commit 02), Better Auth & JWT verification (Commit 03), role-based authorization middleware (Commit 04), Equipment/Favorites/Booking/Owner/Admin APIs, ImgBB image upload proxying, Stripe Checkout & webhook verification (Commit 10+), and automated operational tasks.

---

## Technology Stack

### Implemented Baseline
- **Runtime:** Node.js (ES Modules)
- **Framework:** Express.js (`^5.1.0`)
- **Language:** JavaScript
- **Security & Middleware:** `helmet`, `cors`, `morgan`, `dotenv`

### Planned Integrations (Not Yet Active in Commit 01)
- **Database:** MongoDB (planned Commit 02)
- **Authentication & Sessions:** Better Auth + MongoDB Adapter (planned Commit 03)
- **Authorization:** JWT verification & role-based access control (planned Commits 03–04)
- **Payments:** Stripe Checkout & webhook verification (planned Commit 10)
- **Media Hosting:** ImgBB API integration (planned upload milestone)

---

## Installation

Install backend dependencies from the `server` directory using npm:

```bash
npm install
```

---

## Environment Setup

Copy the example environment file and configure local values without committing `.env`:

```bash
cp .env.example .env
```

Key variables configured in `.env.example`:

- `NODE_ENV` — Runtime mode (`development` or `production`)
- `PORT` — HTTP server port (defaults to `5000`)
- `CLIENT_URL` — Primary frontend URL (default `http://localhost:3000`)
- `CORS_ORIGINS` — Comma-separated list of allowed frontend origins (never use `*` with credentials)
- Future integration placeholders (leave blank until their respective milestones): `MONGODB_URI`, `DB_NAME`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `IMGBB_API_KEY`

---

## Development

Run the Express server in auto-reloading development mode using `nodemon`:

```bash
npm run dev
```

Validate JavaScript syntax across all server source files:

```bash
npm run check
```

---

## Production

Start the HTTP server directly with Node.js:

```bash
npm start
```

---

## API Health Check

### Root Welcome Endpoint
- **Endpoint:** `GET /`
- **Response (`200 OK`):**
```json
{
  "success": true,
  "message": "Welcome to GearNest API"
}
```

### Service Availability Endpoint
- **Endpoint:** `GET /api/health`
- **Response (`200 OK`):**
```json
{
  "success": true,
  "message": "GearNest API is running",
  "data": {
    "service": "GearNest API",
    "status": "healthy",
    "environment": "development"
  }
}
```

*(Note: `/api/health` reports Express HTTP server availability only and does not claim database or authentication readiness yet.)*

---

## Project Structure

```text
server/
  src/
    config/
      cors.js          # Reusable credentialed CORS origin allowlist builder
      env.js           # Environment parsing and milestone-scoped validation
    middleware/
      errorHandler.js  # Centralized JSON error formatter & malformed JSON handler
      notFound.js      # 404 route fallthrough handler
    routes/
      health.routes.js # Service health endpoint (/api/health)
      index.js         # Central API router (/api)
    utils/
      ApiError.js      # Operational error class with HTTP status & metadata
      asyncHandler.js  # Promise-safe Express route wrapper
    app.js             # Express middleware, route mounting, and error pipeline
    server.js          # HTTP listener, startup error handling, graceful shutdown
  .env.example
  .gitignore
  package.json
  README.md
```
