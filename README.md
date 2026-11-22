::: {align="center"}
# ⚙️ GearNest API

### The engine behind the equipment rental marketplace.

**A role-secured REST API for equipment discovery, rental reservations,
payments, and marketplace operations.**

```{=html}
<p>
```
`<img src="https://img.shields.io/badge/Backend-Express.js-222222?style=for-the-badge&logo=express" alt="Express.js">`{=html}
`<img src="https://img.shields.io/badge/Database-MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white" alt="MongoDB">`{=html}
`<img src="https://img.shields.io/badge/Auth-Better%20Auth-111111?style=for-the-badge" alt="Better Auth">`{=html}
`<img src="https://img.shields.io/badge/Payments-Stripe-635BFF?style=for-the-badge&logo=stripe&logoColor=white" alt="Stripe">`{=html}
`<img src="https://img.shields.io/badge/Language-JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=222222" alt="JavaScript">`{=html}
```{=html}
</p>
```
```{=html}
<p>
```
`<a href="[SERVER_REPOSITORY_URL]">`{=html}Server
Repository`</a>`{=html} ·
`<a href="[LIVE_API_BASE_URL]/api/health">`{=html}API
Health`</a>`{=html} · `<a href="[CLIENT_REPOSITORY_URL]">`{=html}Client
Repository`</a>`{=html}
```{=html}
</p>
```
:::

------------------------------------------------------------------------

## 📖 Table of Contents

-   [Overview](#-overview)
-   [System Architecture](#-system-architecture)
-   [User Roles](#-user-roles)
-   [Core Capabilities](#-core-capabilities)
-   [Technology Stack](#-technology-stack)
-   [Getting Started](#-getting-started)
-   [Environment Configuration](#-environment-configuration)
-   [Database Design](#-database-design)
-   [Authentication and
    Authorization](#-authentication-and-authorization)
-   [API Reference](#-api-reference)
-   [Rental and Payment Lifecycle](#-rental-and-payment-lifecycle)
-   [Security Design](#-security-design)
-   [Available Scripts](#-available-scripts)
-   [Testing](#-testing)
-   [Deployment](#-deployment)
-   [Troubleshooting](#-troubleshooting)
-   [Project Status](#-project-status)

------------------------------------------------------------------------

## 🌿 Overview

**GearNest API** powers a multi-role equipment rental marketplace. It
provides the server-side services that connect customers looking for
equipment with owners who want to make their equipment available for
rent.

The API is responsible for the platform's trusted business operations:

-   User identity and session management.
-   JWT verification and role-based authorization.
-   Equipment listings, moderation, and discovery.
-   Customer favorites.
-   Date-aware rental availability and reservations.
-   Server-calculated rental pricing.
-   Stripe Checkout session creation and webhook fulfillment.
-   Customer, Owner, and Admin rental management.
-   Platform and owner analytics.

The backend is designed around **Express.js**, **MongoDB**, and **Better
Auth**, with Stripe used for hosted payment checkout.

> **Project links and deployment values:** Replace the bracketed
> repository and API URL placeholders in this README with the actual
> server repository and verified production URL before publishing.

## 🧭 System Architecture

``` mermaid
flowchart TD
    C[Next.js Client] -->|HTTPS / REST API| E[Express.js API]
    C -->|Better Auth session| B[Better Auth]
    E --> B
    B --> M[(MongoDB)]
    E --> M
    E -->|Create Checkout Session| S[Stripe Checkout]
    S -->|Signed webhook| W[Stripe Webhook Handler]
    W --> M
    E --> I[ImgBB Image Hosting]
    E --> N[Email Provider - optional]
```

### Request lifecycle

1.  The client sends a request to the Express API.
2.  Better Auth manages the user's authentication session.
3.  Protected API requests carry a signed JWT in the `Authorization`
    header.
4.  `verifyToken` verifies the JWT and loads the current user.
5.  Role middleware checks whether the user may perform the requested
    operation.
6.  Controllers validate input and call application services.
7.  Services read or write MongoDB records.
8.  Payment fulfillment is performed only after a verified Stripe
    webhook.

## 👥 User Roles

  -----------------------------------------------------------------------
  Role                                Permissions
  ----------------------------------- -----------------------------------
  **Customer**                        Browse approved listings, manage
                                      favorites, check rental
                                      availability, create reservations,
                                      pay through checkout, and view
                                      personal rental history.

  **Owner**                           Submit equipment, manage owned
                                      listings, view rentals associated
                                      with their equipment, and access
                                      owner analytics.

  **Admin**                           Manage users and roles, review
                                      equipment submissions, monitor
                                      platform rentals, and access
                                      platform analytics.
  -----------------------------------------------------------------------

### Role naming

The application uses `Customer`, `Owner`, and `Admin` as its canonical
database roles.

The assignment's `verifyRenter` middleware maps to the **Customer**
role. It does not introduce a separate `Renter` role.

------------------------------------------------------------------------

## 🚀 Core Capabilities

### 🔐 Authentication

-   Better Auth with MongoDB adapter.
-   Email and password authentication.
-   Google OAuth configuration.
-   Secure session management.
-   JWT issuance and JWKS-based verification.
-   Current-user lookup for protected requests.
-   Server-side role authorization.
-   Public registration defaults to `Customer`.

Password policy for registration:

-   At least one uppercase letter.
-   At least one lowercase letter.
-   At least six characters.

Email verification and forgot-password flows are intentionally excluded
from the assignment scope.

### 🧰 Equipment Marketplace

-   Owner equipment submission.
-   Equipment image upload through the server-side ImgBB integration.
-   Equipment listing update and deletion with ownership checks.
-   Public discovery of approved equipment only.
-   Featured equipment retrieval with a database limit.
-   Search by equipment name, location, and category.
-   Category and rental-type filters.
-   Minimum and maximum price filters.
-   Availability filters.
-   Sorting and server-side pagination.
-   Admin approval, rejection, editing, and deletion/archive controls.

Equipment approval states:

  State        Meaning
  ------------ -----------------------------------------------
  `Pending`    Waiting for Admin review.
  `Approved`   Eligible for public marketplace display.
  `Rejected`   Not available for public marketplace display.

New Owner submissions must be assigned `Pending` by the server. Owners
cannot approve their own listings.

### ❤️ Favorites

-   Add an approved equipment item to favorites.
-   Retrieve the authenticated Customer's favorites.
-   Check whether an item is saved.
-   Remove a favorite.
-   Enforce a unique `userId + equipmentId` relationship.
-   Keep favorite data isolated by authenticated user.

### 📅 Booking and Availability

-   Validate rental start and end dates.
-   Calculate inclusive rental days.
-   Check overlapping bookings.
-   Include unexpired temporary reservations in inventory calculations.
-   Validate requested quantity.
-   Calculate rental totals on the server.
-   Create temporary booking intents before checkout.
-   Expire unpaid reservations.
-   Protect inventory against concurrent over-reservation using MongoDB
    transactions where supported.

### 💳 Stripe Payments

-   Create Stripe Hosted Checkout Sessions on the server.
-   Derive the payable amount from the stored booking intent.
-   Validate currency and convert amounts to Stripe minor units.
-   Attach booking references as Stripe metadata.
-   Use idempotency protection for checkout creation.
-   Verify webhook signatures using the original raw request body.
-   Verify Checkout Session and payment status.
-   Create final booking and payment records after verified payment.
-   Prevent duplicate webhook fulfillment.

**A browser redirect is never treated as proof of payment.**

### 📊 Dashboard Analytics

**Admin analytics**

-   Total users.
-   Total equipment.
-   Total finalized bookings.
-   Pending equipment approvals.
-   Completed rentals.
-   Verified collected revenue.
-   Monthly booking statistics.
-   Monthly revenue statistics.
-   Equipment approval distribution.

**Owner analytics**

-   Total listed equipment.
-   Completed rentals.
-   Eligible owner earnings.
-   Monthly earnings.
-   Monthly rental activity.
-   Equipment performance summaries where implemented.

Analytics must be calculated from MongoDB records. Pending or failed
payments must not be counted as collected revenue.

------------------------------------------------------------------------

## 🧱 Technology Stack

  Technology                        Responsibility
  --------------------------------- --------------------------------------------
  **Node.js**                       JavaScript runtime
  **Express.js**                    REST API and middleware
  **MongoDB**                       Application database
  **MongoDB Node.js Driver**        Database connectivity and aggregation
  **Better Auth**                   Authentication and session management
  **Better Auth MongoDB Adapter**   Better Auth persistence
  **Better Auth JWT Plugin**        Signed access JWT and JWKS
  **jose**                          JWT/JWKS verification
  **Stripe Node SDK**               Checkout Sessions and webhook verification
  **ImgBB**                         Equipment image hosting
  **dotenv**                        Environment configuration
  **cors**                          Cross-origin request policy
  **helmet**                        HTTP security headers
  **multer**                        Multipart image upload handling
  **node-cron**                     Optional scheduled booking updates
  **Nodemailer / SMTP provider**    Optional email notifications

> Confirm the exact installed package names and versions against the
> server's current `package.json`. Optional integrations should only be
> listed as installed when they are actually present.

## ⚙️ Getting Started

### Prerequisites

-   Node.js compatible with the installed dependencies.
-   npm.
-   A MongoDB database.
-   Google OAuth credentials for Google sign-in.
-   Stripe test-mode credentials for checkout testing.
-   ImgBB API key for server-side image uploads.

### 1. Clone the server repository

Replace the placeholder with the actual server repository URL:

``` bash
git clone [SERVER_REPOSITORY_URL]
cd [SERVER_PROJECT_DIRECTORY]
```

### 2. Install dependencies

``` bash
npm install
```

### 3. Configure environment variables

Create a local `.env` file from the example:

``` bash
cp .env.example .env
```

On Windows PowerShell:

``` powershell
Copy-Item .env.example .env
```

Add the credentials for the services enabled in your environment. Never
commit `.env`.

### 4. Start the development server

If the repository defines the `dev` script:

``` bash
npm run dev
```

If the project uses a different script, follow the scripts in
`package.json`.

### 5. Check server health

``` http
GET /api/health
```

Database readiness:

``` http
GET /api/health/ready
```

The liveness endpoint indicates whether the API process is running. The
readiness endpoint should indicate whether the database is available.

------------------------------------------------------------------------

## 🔑 Environment Configuration

The following is a **template**, not a source of real credentials. Keep
actual values in the private server environment.

``` env
# Application
NODE_ENV=development
PORT=5000

# Frontend origins
CLIENT_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000

# MongoDB
MONGODB_URI=
DB_NAME=gearnest

# Better Auth
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:5000
BETTER_AUTH_JWKS_URL=http://localhost:5000/api/auth/jwks

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_CURRENCY=bdt

# ImgBB
IMGBB_API_KEY=

# Booking reservation
BOOKING_HOLD_MINUTES=10

# Optional Admin bootstrap
ADMIN_NAME=
ADMIN_EMAIL=
ADMIN_PASSWORD=

# Optional email notifications
MAIL_HOST=
MAIL_PORT=
MAIL_USER=
MAIL_PASSWORD=
MAIL_FROM=
```

Only retain variables that the implementation actually reads. If the
project uses a different variable name, document the actual name rather
than adding an unused setting.

### Environment variable reference

  -------------------------------------------------------------------------
  Variable                  Purpose                 Sensitivity
  ------------------------- ----------------------- -----------------------
  `NODE_ENV`                Runtime environment     Non-secret

  `PORT`                    HTTP server port        Non-secret

  `CLIENT_URL`              Trusted frontend origin Non-secret
                            and return URL base     

  `CORS_ORIGINS`            Allowed browser origins Non-secret

  `MONGODB_URI`             MongoDB connection      **Secret**
                            string                  

  `DB_NAME`                 MongoDB database name   Non-secret

  `BETTER_AUTH_SECRET`      Better Auth             **Secret**
                            signing/secret          
                            configuration           

  `BETTER_AUTH_URL`         Better Auth server base Non-secret
                            URL                     

  `BETTER_AUTH_JWKS_URL`    JWT public-key          Non-secret
                            endpoint, if explicitly 
                            configured              

  `GOOGLE_CLIENT_ID`        Google OAuth client     Configuration
                            identifier              

  `GOOGLE_CLIENT_SECRET`    Google OAuth client     **Secret**
                            secret                  

  `STRIPE_SECRET_KEY`       Stripe server API key   **Secret**

  `STRIPE_WEBHOOK_SECRET`   Stripe webhook signing  **Secret**
                            secret                  

  `STRIPE_CURRENCY`         Configured Checkout     Non-secret
                            currency                

  `IMGBB_API_KEY`           ImgBB upload API key    **Secret**

  `BOOKING_HOLD_MINUTES`    Temporary reservation   Non-secret
                            duration                

  `ADMIN_PASSWORD`          One-time Admin          **Secret**
                            bootstrap credential,   
                            if used                 

  `MAIL_PASSWORD`           Optional email provider **Secret**
                            password                
  -------------------------------------------------------------------------

### Google OAuth callback

For a local Better Auth server using the default authentication base
path:

``` text
http://localhost:5000/api/auth/callback/google
```

Register the exact callback URL in Google Cloud Console. For production,
use the actual HTTPS API domain.

### Stripe webhook URL

Configure Stripe to send events to the deployed backend webhook
endpoint:

``` text
https://[YOUR_API_DOMAIN]/api/payments/webhook
```

The webhook signing secret must match the configured endpoint and
environment.

------------------------------------------------------------------------

## 🗄️ Database Design

The GearNest application uses MongoDB collections for marketplace and
rental operations.

  -----------------------------------------------------------------------
  Collection                          Purpose
  ----------------------------------- -----------------------------------
  `users`                             Better Auth user records and
                                      application profile/role fields,
                                      subject to adapter configuration.

  `equipment`                         Equipment listings, owner
                                      relationship, rental information,
                                      and approval state.

  `bookingIntents`                    Temporary inventory reservations
                                      awaiting payment.

  `bookings`                          Finalized rental bookings.

  `favorites`                         Customer-to-equipment favorite
                                      relationships.

  `payments`                          Verified payment transaction
                                      records.

  `contactMessages`                   Public contact form submissions.

  `stripeWebhookEvents`               Webhook event processing and
                                      idempotency records.
  -----------------------------------------------------------------------

Better Auth may maintain additional authentication collections for
sessions, linked accounts, verification data, and signing keys. Let the
configured Better Auth adapter manage its required records.

### Key relationships

``` mermaid
erDiagram
    USERS ||--o{ EQUIPMENT : owns
    USERS ||--o{ BOOKINGINTENTS : creates
    USERS ||--o{ BOOKINGS : rents
    USERS ||--o{ FAVORITES : saves
    EQUIPMENT ||--o{ BOOKINGINTENTS : reserved_for
    EQUIPMENT ||--o{ BOOKINGS : rented_as
    EQUIPMENT ||--o{ FAVORITES : saved_item
    BOOKINGS ||--o{ PAYMENTS : paid_through
```

### Important data rules

-   Better Auth user IDs must retain their actual identifier type.
-   Equipment, booking, and payment relationships must use consistent
    identifier types.
-   Public equipment queries return approved listings only.
-   Temporary booking intents are not finalized rentals.
-   Payment records must represent verified Stripe outcomes.
-   Historical booking and payment records must be preserved when a
    listing is archived or removed.

------------------------------------------------------------------------

## 🔐 Authentication and Authorization

### Better Auth

Better Auth handles the authentication lifecycle, including:

-   Email/password registration.
-   Email/password sign-in.
-   Google social sign-in.
-   Session management.
-   MongoDB persistence.
-   JWT plugin integration.

Public registration must default to the `Customer` role. The client must
not be trusted to assign privileged roles.

### Required custom Express middleware

  Middleware       Access
  ---------------- ------------------------------
  `verifyToken`    Any valid authenticated user
  `verifyRenter`   Customer
  `verifyOwner`    Owner
  `verifyAdmin`    Admin

The assignment uses the name `verifyRenter`; in GearNest this middleware
authorizes the canonical `Customer` role.

### Protected request example

``` http
GET /api/bookings/my
Authorization: Bearer YOUR_ACCESS_JWT
```

The server must:

1.  Verify the JWT signature using the configured JWKS.
2.  Validate issuer, audience, expiration, and subject.
3.  Load the current user from MongoDB.
4.  Use the current database role for authorization.
5.  Enforce resource ownership in the service/controller.

Never rely only on frontend route protection or a role value supplied in
a request body.

------------------------------------------------------------------------

## 📚 API Reference

**Base URL (local):**

``` text
http://localhost:5000
```

**Base URL (production):**

``` text
https://[YOUR_API_DOMAIN]
```

All paths below are relative to the API base URL. Protected endpoints
require the configured authentication mechanism.

### 1. Health

  Method   Endpoint              Access   Description
  -------- --------------------- -------- --------------------
  `GET`    `/api/health`         Public   Server liveness
  `GET`    `/api/health/ready`   Public   Database readiness

### 2. Authentication

Better Auth manages its authentication routes under the configured base
path. With the default `/api/auth` base path, common operations include:

  ----------------------------------------------------------------------------
  Method                  Endpoint                     Description
  ----------------------- ---------------------------- -----------------------
  `POST`                  `/api/auth/sign-up/email`    Email/password
                                                       registration

  `POST`                  `/api/auth/sign-in/email`    Email/password sign-in

  `POST`                  `/api/auth/sign-in/social`   Social sign-in,
                                                       including Google

  `GET`                   `/api/auth/get-session`      Retrieve current
                                                       session

  `POST`                  `/api/auth/sign-out`         Sign out

  `GET`                   `/api/auth/token`            Retrieve JWT through
                                                       the configured JWT
                                                       plugin

  `GET`                   `/api/auth/jwks`             Public JWT verification
                                                       keys
  ----------------------------------------------------------------------------

Confirm exact route availability against the Better Auth version and
configuration deployed by the server.

### 3. User and Profile APIs

  ----------------------------------------------------------------------------------------
  Method            Endpoint                      Access            Description
  ----------------- ----------------------------- ----------------- ----------------------
  `GET`             `/api/users/me`               Authenticated     Retrieve own profile

  `PATCH`           `/api/users/me`               Authenticated     Update allowed profile
                                                                    fields

  `GET`             `/api/admin/users`            Admin             List users with
                                                                    filters and pagination

  `GET`             `/api/admin/users/:id`        Admin             Retrieve safe user
                                                                    details

  `PATCH`           `/api/admin/users/:id/role`   Admin             Change
                                                                    Customer/Owner/Admin
                                                                    role
  ----------------------------------------------------------------------------------------

Profile updates must use an explicit allowlist. Users must not change
their own role through the profile endpoint.

### 4. Equipment APIs

  --------------------------------------------------------------------------------------
  Method            Endpoint                         Access            Description
  ----------------- -------------------------------- ----------------- -----------------
  `GET`             `/api/equipment`                 Public            Search and browse
                                                                       approved
                                                                       equipment

  `GET`             `/api/equipment/featured`        Public            Retrieve featured
                                                                       approved listings

  `GET`             `/api/equipment/:id`             According to      Retrieve
                                                     listing access    equipment details
                                                     rules             

  `POST`            `/api/equipment`                 Owner             Submit equipment

  `GET`             `/api/equipment/my`              Owner             List own
                                                                       equipment

  `PATCH`           `/api/equipment/:id`             Owner             Update own
                                                                       equipment

  `DELETE`          `/api/equipment/:id`             Owner             Delete/archive
                                                                       own equipment

  `POST`            `/api/uploads/equipment-image`   Owner             Upload equipment
                                                                       image
  --------------------------------------------------------------------------------------

#### Equipment query parameters

  Parameter        Description                            Example
  ---------------- -------------------------------------- --------------------------
  `search`         Search by supported equipment fields   `search=excavator`
  `category`       Filter by category                     `category=Electronics`
  `rentalType`     Filter by rental period type           `rentalType=Daily`
  `minPrice`       Minimum rental price                   `minPrice=500`
  `maxPrice`       Maximum rental price                   `maxPrice=10000`
  `availability`   Inventory availability                 `availability=available`
  `sort`           Sort order                             `sort=price_asc`
  `page`           Page number                            `page=1`
  `limit`          Results per page                       `limit=9`

Example:

``` http
GET /api/equipment?category=Electronics&rentalType=Daily&availability=available&sort=price_asc&page=1&limit=9
```

Public equipment queries must not allow clients to override the
approved-only visibility rule.

### 5. Favorites APIs

  --------------------------------------------------------------------------------------------
  Method            Endpoint                               Access            Description
  ----------------- -------------------------------------- ----------------- -----------------
  `POST`            `/api/favorites`                       Customer          Add an approved
                                                                             equipment item

  `GET`             `/api/favorites`                       Customer          Retrieve own
                                                                             favorites

  `GET`             `/api/favorites/:equipmentId/status`   Customer          Check favorite
                                                                             state

  `DELETE`          `/api/favorites/:equipmentId`          Customer          Remove own
                                                                             favorite
  --------------------------------------------------------------------------------------------

The authenticated user ID is taken from the verified session/JWT, never
from a client-supplied `userId`.

### 6. Booking APIs

  ------------------------------------------------------------------------------------------
  Method            Endpoint                             Access            Description
  ----------------- ------------------------------------ ----------------- -----------------
  `POST`            `/api/bookings/check-availability`   Customer          Check date and
                                                                           quantity
                                                                           availability

  `POST`            `/api/bookings`                      Customer          Create a
                                                                           temporary booking
                                                                           reservation

  `GET`             `/api/bookings/my`                   Customer          Retrieve own
                                                                           finalized rentals

  `GET`             `/api/bookings/:id`                  Customer          Retrieve own
                                                                           booking details
  ------------------------------------------------------------------------------------------

Booking input includes:

-   `equipmentId`
-   `startDate`
-   `endDate`
-   `quantity`
-   `contactNumber`
-   `deliveryAddress`
-   `additionalNotes` (optional)

The backend calculates the rental amount from the stored equipment price
and rental type. The frontend amount is not authoritative.

### 7. Payment APIs

  -----------------------------------------------------------------------------------------------
  Method            Endpoint                                  Access            Description
  ----------------- ----------------------------------------- ----------------- -----------------
  `POST`            `/api/payments/create-checkout-session`   Customer          Create a Stripe
                                                                                Checkout Session
                                                                                for an eligible
                                                                                booking intent

  `POST`            `/api/payments/webhook`                   Stripe signature  Receive and
                                                                                verify Stripe
                                                                                events

  `GET`             `/api/payments/session/:sessionId`        Owning Customer   Retrieve verified
                                                                                payment/booking
                                                                                status
  -----------------------------------------------------------------------------------------------

Checkout creation request:

``` json
{
  "bookingIntentId": "BOOKING_INTENT_ID"
}
```

The server retrieves the authoritative amount and booking details from
MongoDB.

### 8. Owner APIs

  --------------------------------------------------------------------------------
  Method            Endpoint                   Access            Description
  ----------------- -------------------------- ----------------- -----------------
  `GET`             `/api/owner/rentals`       Owner             Retrieve rentals
                                                                 for owned
                                                                 equipment

  `GET`             `/api/owner/rentals/:id`   Owner             Retrieve an
                                                                 authorized rental
                                                                 detail

  `GET`             `/api/owner/analytics`     Owner             Retrieve owner
                                                                 analytics
  --------------------------------------------------------------------------------

Owner queries must be scoped to the authenticated Owner's equipment and
rental records.

### 9. Admin APIs

  ------------------------------------------------------------------------------------------
  Method            Endpoint                             Access            Description
  ----------------- ------------------------------------ ----------------- -----------------
  `GET`             `/api/admin/equipment`               Admin             List all
                                                                           equipment and
                                                                           review states

  `GET`             `/api/admin/equipment/:id`           Admin             Retrieve
                                                                           equipment details

  `PATCH`           `/api/admin/equipment/:id/approve`   Admin             Approve equipment

  `PATCH`           `/api/admin/equipment/:id/reject`    Admin             Reject equipment

  `PATCH`           `/api/admin/equipment/:id`           Admin             Update equipment

  `DELETE`          `/api/admin/equipment/:id`           Admin             Delete/archive
                                                                           equipment

  `GET`             `/api/admin/rentals`                 Admin             List platform
                                                                           rentals

  `GET`             `/api/admin/rentals/:id`             Admin             Retrieve rental
                                                                           details

  `GET`             `/api/admin/analytics`               Admin             Retrieve platform
                                                                           analytics
  ------------------------------------------------------------------------------------------

### 10. Contact API

  -----------------------------------------------------------------------
  Method            Endpoint          Access            Description
  ----------------- ----------------- ----------------- -----------------
  `POST`            `/api/contact`    Public,           Submit a contact
                                      rate-limited      inquiry

  -----------------------------------------------------------------------

Example request:

``` json
{
  "name": "Customer Name",
  "email": "customer@example.com",
  "inquiryType": "General Inquiry",
  "subject": "Equipment rental question",
  "message": "I would like to learn more about renting equipment."
}
```

The server should validate and persist the inquiry before returning
success.

### Standard response format

Successful response:

``` json
{
  "success": true,
  "message": "Operation completed successfully",
  "data": {}
}
```

Error response:

``` json
{
  "success": false,
  "message": "A clear error message"
}
```

Paginated response:

``` json
{
  "success": true,
  "data": [],
  "pagination": {
    "currentPage": 1,
    "limit": 10,
    "totalItems": 0,
    "totalPages": 0
  }
}
```

------------------------------------------------------------------------

## 🔄 Rental and Payment Lifecycle

### Reservation lifecycle

``` mermaid
flowchart TD
    A[Customer submits rental request] --> B[Validate dates and quantity]
    B --> C[Check overlapping bookings and active holds]
    C --> D{Inventory available?}
    D -- No --> E[Reject reservation]
    D -- Yes --> F[Create temporary booking intent]
    F --> G[Create Stripe Checkout Session]
    G --> H{Verified payment webhook}
    H -- Paid --> I[Create final booking and payment record]
    I --> J[Mark intent Converted]
    H -- Failed or expired --> K[Release reservation according to policy]
```

### Pricing rules

The server calculates the authoritative rental total.

  Rental type   Billable units
  ------------- ------------------------------------
  Daily         Inclusive rental days
  Weekly        `ceil(inclusive rental days / 7)`
  Monthly       `ceil(inclusive rental days / 30)`

Formula:

``` text
Total = Equipment Rental Price × Billable Units × Quantity
```

The actual stored price, rental type, and quantity are validated by the
server.

### Payment confirmation

1.  The server creates a Checkout Session.
2.  The Customer completes checkout on Stripe.
3.  Stripe sends a signed webhook.
4.  The server verifies the original raw request body and signature.
5.  The server retrieves and validates the Checkout Session and payment
    status.
6.  A database transaction creates the final booking and payment record
    and converts the booking intent.
7.  Duplicate events are handled idempotently.

The frontend success page only reads the server's verified status.

------------------------------------------------------------------------

## 🛡️ Security Design

Security-sensitive operations must be enforced on the server.

### Authentication

-   Verify signed JWTs using the configured Better Auth JWKS.
-   Validate issuer, audience, expiration, and subject.
-   Load the current user from MongoDB.
-   Use the current database role for authorization.

### Authorization and ownership

-   Customers access only their own favorites and bookings.
-   Owners access only their own equipment and associated rentals.
-   Admin APIs require the Admin role.
-   Owners cannot approve or reject their own equipment.
-   Users cannot change their own role through profile updates.

### Input and database safety

-   Validate body, query, and path parameters.
-   Validate MongoDB ObjectIds where applicable.
-   Use explicit field allowlists to prevent mass assignment.
-   Escape search input and restrict query operators.
-   Apply request-size and upload limits.
-   Preserve historical booking and payment relationships.

### Payment safety

-   Keep Stripe secret keys on the server.
-   Verify webhook signatures using the original raw body.
-   Do not trust browser redirects as payment confirmation.
-   Use idempotency to prevent duplicate Checkout Sessions and webhook
    fulfillment.
-   Never store card details.

### HTTP and deployment safety

-   Use Helmet and a restrictive CORS allowlist.
-   Use HTTPS in production.
-   Keep environment files out of Git.
-   Do not expose stack traces or credentials in production responses.

------------------------------------------------------------------------

## 🧪 Available Scripts

Check the server's actual `package.json` before running these commands.
The project prompts define the following intended scripts:

  Command           Purpose
  ----------------- ---------------------------------------
  `npm run dev`     Start the development server
  `npm start`       Start the production server
  `npm run check`   Run the configured code/syntax checks
  `npm test`        Run automated tests, if configured

Do not assume an optional script exists until it is present in
`package.json`.

## 🧰 Testing Checklist

Before deployment, verify the following against a test database and
Stripe test mode.

### Authentication and roles

-   [ ] Email/password registration and login.
-   [ ] Google OAuth callback.
-   [ ] Session retrieval and logout.
-   [ ] JWT signature and JWKS verification.
-   [ ] Customer, Owner, and Admin authorization.
-   [ ] Session persistence after browser refresh.

### Marketplace

-   [ ] Public endpoint returns approved equipment only.
-   [ ] Featured endpoint respects its MongoDB limit.
-   [ ] Search and filters are applied server-side.
-   [ ] Sorting and pagination return accurate metadata.
-   [ ] Owner can manage only owned listings.
-   [ ] Admin approval and rejection update public visibility.

### Favorites and rentals

-   [ ] Favorites persist in MongoDB.
-   [ ] Duplicate favorites are prevented.
-   [ ] Date overlap and quantity checks work.
-   [ ] Rental pricing is calculated by the server.
-   [ ] Temporary booking holds expire correctly.
-   [ ] Concurrent reservations cannot overbook inventory.
-   [ ] Customer and Owner records remain isolated.

### Payments

-   [ ] Checkout Session is created from a valid booking intent.
-   [ ] Currency and minor-unit conversion are correct.
-   [ ] Webhook signature verification succeeds.
-   [ ] Duplicate webhook events do not duplicate records.
-   [ ] Final booking and payment records are consistent.
-   [ ] Payment success is not inferred from a browser redirect.

### Production

-   [ ] Health and database readiness endpoints work.
-   [ ] CORS allows the deployed frontend origin.
-   [ ] No credentials are committed.
-   [ ] Production environment variables are configured.
-   [ ] Direct API and frontend route refreshes work.
-   [ ] Logs contain no secrets or sensitive payment data.

------------------------------------------------------------------------

## 🌍 Deployment

Deploy the Express API to a Node.js-compatible hosting platform and
configure the production environment there.

### Deployment checklist

1.  Set the production start command from the actual `package.json`.
2.  Configure the hosting platform's assigned `PORT`.
3.  Configure MongoDB connection and database name.
4.  Configure Better Auth production URL and secret.
5.  Add the production frontend origin to Express CORS and Better Auth
    trusted origins.
6.  Configure Google OAuth production callback URL.
7.  Configure Stripe secret key and webhook signing secret for the
    selected environment.
8.  Configure ImgBB credentials if image upload is enabled.
9.  Configure optional email credentials if notifications are enabled.
10. Deploy the API.
11. Test `GET /api/health`.
12. Test `GET /api/health/ready`.
13. Test a public equipment request.
14. Test a protected request with a valid JWT.
15. Test CORS from the real deployed frontend.
16. Test Stripe webhooks in test mode before enabling live payment.

### Production API

-   **Live API URL:** Not supplied / update after deployment.
-   **Health endpoint:** `[LIVE_API_BASE_URL]/api/health`
-   **Readiness endpoint:** `[LIVE_API_BASE_URL]/api/health/ready`

Do not publish a guessed URL. Replace the placeholders only after the
deployment is verified.

------------------------------------------------------------------------

## 🧯 Troubleshooting

  -----------------------------------------------------------------------
  Issue                               Checks
  ----------------------------------- -----------------------------------
  MongoDB connection fails            Verify `MONGODB_URI`, database
                                      access, network allowlist, and
                                      deployment connectivity.

  Better Auth callback fails          Verify `BETTER_AUTH_URL`, trusted
                                      origins, Google credentials, and
                                      exact callback URL.

  JWT returns 401                     Verify Bearer token, issuer,
                                      audience, expiry, JWKS URL, and
                                      current user record.

  API returns 403                     Verify the current database role
                                      and route middleware.

  CORS error                          Verify exact frontend origin,
                                      credentials, preflight handling,
                                      and cookie settings.

  Equipment does not appear publicly  Verify listing status is `Approved`
                                      and the record is not archived.

  Booking is unavailable              Check overlapping finalized
                                      bookings and unexpired booking
                                      intents.

  Checkout cannot be created          Verify booking intent ownership,
                                      expiry, Stripe key, currency, and
                                      account configuration.

  Webhook signature fails             Ensure the route receives the
                                      unmodified raw request body and the
                                      correct webhook secret.

  Payment remains pending             Check Stripe event delivery,
                                      webhook logs, and database
                                      transaction outcome.

  Analytics values look wrong         Check payment status, refunds,
                                      currency units, aggregation joins,
                                      and date boundaries.
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 📌 Project Status

Use this section to report the **actual repository and deployment
state** before submission.

  -----------------------------------------------------------------------
  Area                                Verification
  ----------------------------------- -----------------------------------
  Express API                         Confirm server starts and health
                                      endpoint responds

  MongoDB                             Confirm live connection and
                                      required indexes

  Better Auth                         Confirm registration, login, Google
                                      OAuth, and sessions

  JWT/RBAC                            Confirm all four required
                                      middleware functions

  Equipment                           Confirm CRUD, approval, search,
                                      filters, and pagination

  Favorites                           Confirm database persistence and
                                      customer isolation

  Booking                             Confirm availability, price
                                      calculation, and reservation safety

  Stripe                              Confirm Checkout, signed webhooks,
                                      and payment persistence

  Rental APIs                         Confirm Customer, Owner, and Admin
                                      data isolation

  Analytics                           Confirm MongoDB-derived metrics and
                                      correct revenue accounting

  Contact                             Confirm message validation and
                                      persistence

  Deployment                          Add verified production API URL
  -----------------------------------------------------------------------

### Known deployment dependencies

-   Valid MongoDB deployment and credentials.
-   Better Auth production secret and URL.
-   Google OAuth credentials and callback configuration.
-   Stripe account eligibility, supported currency, and webhook
    configuration.
-   ImgBB credentials for hosted image uploads.
-   SMTP credentials only if email notifications are enabled.

Do not describe an integration as production-ready until it has been
tested with its real service configuration.

------------------------------------------------------------------------

## 📝 Assignment Submission

**Project:** GearNest --- Equipment Rental Platform\
**Assignment:** Assignment 9 --- Category 003\
**Server repository:** \[Add actual server GitHub URL\]\
**Client repository:**
[b14-A-009-client](https://github.com/iRfANhAiDeRABiR/b14-A-009-client)\
**Live API:** \[Add verified production API URL\]

### Submission checklist

-   [ ] At least 12 meaningful server commits.
-   [ ] README contains project purpose, live URL, key features, and npm
    packages.
-   [ ] MongoDB credentials are secured in environment variables.
-   [ ] Authentication and RBAC are tested.
-   [ ] Server deployment is working.
-   [ ] No CORS, 404, 502, 503, or 504 errors on required routes.
-   [ ] Stripe test-mode checkout and webhook fulfillment are verified.
-   [ ] Client and server repositories are linked correctly.
-   [ ] Admin test account is provisioned securely.

------------------------------------------------------------------------

::: {align="center"}
# GearNest API

**Reliable services for a simpler equipment rental experience.**

Built with Express.js · MongoDB · Better Auth · Stripe
:::
