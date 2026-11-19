# Khet Se — API

**Fresh from Local Farms to Your Home.** REST API for Khet Se, a geo-spatial marketplace connecting organic farmers directly with customers in their city.

Express + TypeScript · MongoDB (Mongoose, 2dsphere geospatial indexes, transactions) · JWT auth · Zod validation.

The web app lives in **[khet-se-client](https://github.com/ashutosh-iitbhilai/khet-se-client)**. The two apps are independent: separate repos, builds and deployments. The client talks to this API only over REST.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architecture, schema, API design, UI system, roadmap
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): hosting, environment variables, release procedure, Docker, scaling, security checklist

## Prerequisites

- Node.js ≥ 18.18 (20 LTS recommended)
- MongoDB ≥ 4.4 running locally, or a MongoDB Atlas URI

> **Checkout and transactions.** On a replica set (Atlas, or a local single-node replica set) checkout
> runs inside a MongoDB transaction. On a standalone `mongod` it still cannot oversell: every stock
> change is a single conditional update, and partial reservations are undone on failure. The API
> logs which mode it is in at startup. To get transactions locally, start a single-node replica set:
> `mongod --replSet rs0 --dbpath <dir>` then once `mongosh --eval 'rs.initiate()'`, and use
> `MONGODB_URI=mongodb://127.0.0.1:27017/khet-se?replicaSet=rs0`. Use a replica set in production.

## Setup

```bash
cp .env.example .env        # set MONGODB_URI and a long random JWT_SECRET (openssl rand -hex 48)
npm install
npm run seed:catalogue      # 14 fresh + 5 dry catalogue products
npm run dev                 # http://localhost:5000/api/health
```

Optionally load fictional demo farms around Raipur so there is something to browse:

```bash
npm run seed:demo               # 8 demo farms, 38 listings
npm run seed:demo -- --reset    # remove them again
```

Demo farmers use `@demo.khetse.test` emails with random, unusable passwords (set `DEMO_PASSWORD` before seeding to log in as them). Their star ratings are placeholders, not real reviews. Never run `seed:demo` in production.

## Scripts

| Script | Purpose |
|---|---|
| `dev` / `build` / `start` | tsx watch · compile to `dist/` · run compiled |
| `typecheck` / `test` / `test:watch` | type-check src + tests · unit + integration tests |
| `db:indexes` (`:prod`) | Create/update MongoDB indexes. Run once per deploy (auto-indexing is off in production). |
| `seed:catalogue` / `seed:demo` | Catalogue · fictional demo farms (dev only) |
| `seed:algo` / `algo:check` | Durg–Bhilai algorithm test bed (real OpenStreetMap places) and the independent checker of discovery, ranking and checkout against it. See [docs/ALGORITHM_CHECK.md](docs/ALGORITHM_CHECK.md) |
| `admin:create` (`:prod`) | Create or promote an admin: `ADMIN_PHONE`, `ADMIN_NAME`, `ADMIN_PASSWORD` (≥ 12 chars), optional `ADMIN_EMAIL`. Admins can't sign up in the app. |
| `workload` | Workload model / load test with customers, farmers and delivery partners together (`setup`, `run --profile peak\|stress\|ramp`, `cleanup`). See [docs/WORKLOAD_MODEL.md](docs/WORKLOAD_MODEL.md) |
| `seed:activity` | Demo farms plus 6 demo customers and ~40 orders over the last 4 weeks, all placed through the order service (dev only; `-- --reset` removes them) |
| `bench` / `loadtest` | Query benchmark on a synthetic city-sized dataset · HTTP load test |
| `reservations:check` (`:prod`) | Compare each listing's reserved stock with open orders; `-- --fix` repairs drift |

## Testing

```bash
npm test     # 110 tests: unit + API integration
```

- **How they run:** the integration tests (`test/`) drive the real Express app (Supertest) against an **in-memory MongoDB replica set**, so checkout exercises real transactions. Each test file gets its own database.
- **What they cover:**
  - auth and roles; farmer onboarding and inventory rules;
  - geo ranking, radius widening and delivery reach;
  - quotes and idempotent ordering;
  - 6 buyers racing for 3 units (no overselling) and rollback when a line sells out mid-checkout;
  - the farmer flow with delivery codes, cancellations and access control;
  - unpaid-order expiry, the farmer acceptance deadline, delivery-code lockout and the reserved-stock audit;
  - sessions: refresh-token rotation, reuse detection, logout everywhere, suspension;
  - forgot/reset password (single-use links, no account enumeration) and Google sign-in against a mocked Google token endpoint;
  - the full Razorpay flow and payment reconciliation against a mocked Razorpay API.
- **Test MongoDB binary:** downloaded and cached on first run. To reuse a local `mongod`: `MONGOMS_SYSTEM_BINARY=/usr/bin/mongod npm test`.
- **CI** (`.github/workflows/ci.yml`) runs typecheck, tests and build, and builds the Docker image.

## Run the full stack with Docker

Clone [khet-se-client](https://github.com/ashutosh-iitbhilai/khet-se-client) next to this repo, then:

```bash
JWT_SECRET=$(openssl rand -hex 48) docker compose up --build    # MongoDB replica set, Redis, API, web
docker compose run --rm api node dist/scripts/seed-catalogue.js
```

## API

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | – | DB connectivity check |
| POST | `/api/auth/register` | – | `{ name, phone, email?, password, role: customer \| farmer \| delivery }`. The mobile number is required and unique (any common format: `+91 98765 43210`, `098765…`); email is optional and unique when given. |
| POST | `/api/auth/login` | – | `{ identifier, password }`, where `identifier` is a mobile number or an email (older clients may send `email`). Sets a 15-min access cookie and a 30-day refresh cookie (httpOnly, path `/api/auth`); also returns the access `token` |
| POST | `/api/auth/refresh` | refresh cookie | Rotates the refresh token and issues a new access token. A reused token revokes that session family. |
| POST | `/api/auth/logout` | – | Ends this session on the server and clears cookies |
| POST | `/api/auth/logout-all` | any | Ends every session of the account → `{ sessionsEnded }` |
| GET | `/api/auth/providers` | – | `{ google, passwordReset }`: which sign-in options to show |
| POST | `/api/auth/forgot-password` | – | `{ identifier }` (mobile or email); the link goes to the account's email. Mobile-only accounts can't reset by email until they add one. Same reply whether or not the account exists; emails a single-use link (30 min). 5 per 15 min per IP. |
| POST | `/api/auth/reset-password` | – | `{ token, password }`. Sets the password and ends every session. |
| GET | `/api/auth/google?role=customer\|farmer&next=/path` | – | Starts Google sign-in (OAuth code flow + PKCE); ends with a redirect back to the web app, signed in |
| GET | `/api/auth/google/callback` | Google | Redirect target registered with Google. On failure redirects to `/login?error=<code>` |
| GET | `/api/auth/me` | any | Current user (cookie or `Authorization: Bearer`) |
| PATCH | `/api/users/me` | any | Update name, mobile number, email (add, change or remove) |
| GET | `/api/farmers/me` · `/api/farmers/me/overview` | farmer | Own profile + farms · dashboard counts |
| POST/PUT | `/api/farmers/profile` | farmer | Bio, practices, organic certificate (→ pending review) |
| GET | `/api/farmers/nearby?lng&lat` | – | Farms that deliver to you; `radiusKm`, `type`, `category`, `maxPrice`, `organic`, `sort=recommended\|distance\|rating`, pagination |
| GET | `/api/recommendations/farmers?lng&lat` | – | Same filters, always ranked by recommendation score |
| GET | `/api/inventory?lng&lat` | – | Listings near you; `q`, `product`, `farm`, filters, `sort=recommended\|distance\|price_asc\|price_desc\|freshness` |
| GET | `/api/recommendations/products?lng&lat` | – | Listings ranked by score, spread across farms |
| GET | `/api/inventory/:id?lng&lat` | – | Public listing detail, with distance when a location is given |
| GET | `/api/farmers/:id` | – | Public profile, farms, in-stock listings |
| GET | `/api/farms/mine` · POST `/api/farms` · PUT `/api/farms/:id` | farmer | Farm with GeoJSON location; moving a farm re-syncs its listings |
| GET | `/api/products` · `/api/products/:idOrSlug` | – | Catalogue; `type`, `category`, `q`, pagination |
| POST/PUT/DELETE | `/api/products/:id` | admin | Listed products are deactivated, not deleted |
| GET | `/api/inventory/mine` · `/api/inventory/mine/:id` | farmer | `status=all\|active\|low\|out\|inactive`, `type`, `q` |
| POST · PUT · DELETE | `/api/inventory` · `/api/inventory/:id` | farmer | Fresh needs harvest date; dry needs processed + expiry |
| PATCH | `/api/inventory/:id/stock` | farmer | `{ mode: set\|add, quantity }`. Atomic, never below 0. |
| GET | `/api/geo/search?q=` · `/api/geo/reverse?lat&lng` | – | OpenStreetMap Nominatim proxy (cached, throttled, India only) |
| GET | `/api/uploads/config` · POST `/api/uploads/sign` | farmer/admin | Signed direct-to-Cloudinary upload |

### Orders and payments

| Method | Path | Who | Notes |
|---|---|---|---|
| GET/POST/PUT/DELETE | `/api/addresses[/:id]` | customer | Saved delivery addresses with map pin; one default |
| POST | `/api/orders/quote` | anyone | `{ items: [{listing, quantity}], location }` → priced groups + issues |
| POST | `/api/orders` | customer | `Idempotency-Key` header; `{ items, addressId, paymentMethod, expectedTotal }` |
| GET | `/api/orders/my-orders` | customer | Paginated |
| GET | `/api/orders/:id` | owner / farmer in order / admin | Farmers see only their groups and never the delivery code |
| POST | `/api/orders/:id/cancel` | customer | Pending groups only |
| POST | `/api/orders/:id/groups/:groupId/code` | customer | New delivery code; unlocks a group locked after 5 wrong codes |
| POST · DELETE | `/api/orders/:id/groups/:groupId/delivery-partner` | farmer | Hand an accepted/packed group to a delivery partner (it becomes a job on the board) · withdraw the request while nobody has accepted it |
| POST | `/api/orders/:id/pay` | customer | Start or retry online payment |
| GET | `/api/orders/farmer?view=incoming\|active\|completed` | farmer | Order queue |
| PUT | `/api/orders/:id/status` | farmer | `{ groupId, status, note?, code?, deliveryDate? }`. A wrong code returns 400 with tries left; the 5th returns `423 CODE_LOCKED`. |
| GET | `/api/payments/methods` | anyone | `{ cod: true, online: boolean }` |
| POST | `/api/payments/razorpay/verify` | customer | Browser callback verification |
| POST | `/api/payments/razorpay/webhook` | Razorpay | Raw body, `X-Razorpay-Signature` |

### Delivery partners

Register with `role: "delivery"`. A partner sees jobs only after setting a base location and a phone number and going online.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET · PUT | `/api/delivery/profile` | delivery | Vehicle, base location, work-area radius (1–30 km), online/offline |
| GET | `/api/delivery/overview` | delivery | Active and open jobs, today's and this week's earnings, cash collected today |
| GET | `/api/delivery/jobs/available` | delivery | Open jobs whose farm is within the work area, nearest pickup first (`$geoNear`). Areas and pay only, with no phone numbers or exact addresses. |
| GET | `/api/delivery/jobs?view=active\|completed` | delivery | The partner's own jobs, with full pickup and drop details |
| POST | `/api/delivery/jobs/:id/accept` | delivery | Atomic claim: the first partner wins and the rest get `409`. Up to `maxActiveJobs` (3) at a time. |
| POST | `/api/delivery/jobs/:id/release` | delivery | Give a job back before pickup |
| POST | `/api/delivery/jobs/:id/pickup` | delivery | Group → out for delivery |
| POST | `/api/delivery/jobs/:id/deliver` | delivery | `{ code }`, the customer's 4-digit code (same lockout rules as farmers). Group → delivered; COD marked collected. |

### Admin console (role `admin`)

Every change is recorded in an audit trail (`adminactions`) with who, what, when and the reason.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/overview` | People by role, farmers waiting for verification, orders today / 7 days, delivered value (30 days), cash to collect, refunds owed, deliveries without a partner, latest orders |
| GET | `/api/admin/users?role&status&q` | Search by name, mobile or email |
| GET | `/api/admin/users/:id` | Role details: a customer's orders and spend; a farmer's farms, listings, sales and verification; a partner's jobs and payouts; admin history |
| PATCH | `/api/admin/users/:id/status` | `{ status: active \| suspended, reason }`. Suspension ends all sessions; a farmer's produce leaves the marketplace. Admin accounts can't be changed here. |
| GET | `/api/admin/verification?kind=all\|profile\|organic` | Farmers waiting for review, with farm, listings and certificate details |
| POST | `/api/admin/farmers/:id/verification` | `{ profile?, organic?: verified \| rejected, note }`. The note is required when rejecting and is shown to the farmer. A rejected profile hides the farmer from the marketplace and checkout. |
| GET | `/api/admin/orders?status&paymentStatus&paymentMethod&refunds&q&from&to` | Search by order number, name or mobile |
| GET | `/api/admin/orders/:id` | Order with delivery codes, payments, delivery records and admin history |
| POST | `/api/admin/orders/:id/groups/:groupId/cancel` | `{ note }`. Cancels one farm's part (stock released; becomes a refund owed if paid online). |
| POST | `/api/admin/orders/:id/refunds` | `{ amount, reference?, note? }`. Records a refund paid outside the app; never more than is owed. |
| GET | `/api/admin/payments?provider&status` | Transactions with totals by method and status |
| GET | `/api/admin/audit` | Audit trail |

Payout per job: ₹20 + ₹6/km of farm-to-customer distance, minimum ₹30 (`config/delivery.ts`). It is paid by Khet Se and independent of the customer's delivery fee.

## How recommendations work

1. MongoDB `$geoNear` (compound 2dsphere index) finds farms or listings within the radius. Distances are computed by MongoDB, never by hand.
2. Only farms that are open, deliver, and whose own delivery radius reaches the customer are kept.
3. Each candidate gets six scores from 0 to 1: **proximity**, **freshness** (shelf life left), **stock**, **rating** (Bayesian, so one 5★ review can't beat many 4.7★ ones), **price** (compared only with the same product, unit and pack size), and **organic verification**.
4. The weighted sum ranks results. Weights live in `src/config/recommendation.ts`.
5. If too few results are found, the radius widens (8 → 15 → 25 km by default) and the response says so (`meta.expanded`).
6. "Recommended" product lists are spread across farms so one large farm can't fill the page.
7. Results are cached for 60 seconds (in memory, or Redis via `REDIS_URL`) and cleared whenever a farmer changes stock, listings or farm details.

On a synthetic city (2,000 farms, 28,900 listings) recommended products take about 29 ms at p50 (`npm run bench`). Scoring functions and their unit tests are in `src/services/recommendation/scoring.ts`.

## How ordering works

1. **Quote:** the cart asks the API for a quote: live prices, stock, minimum order sizes, and whether each farm delivers to the address. Delivery is charged per farm: ₹20 + ₹3/km, capped at ₹60, free above ₹300 from that farm (`src/config/orders.ts`).
2. **Checkout** re-quotes on the server. If anything changed it refuses with `409 CART_CHANGED` / `PRICE_CHANGED` and the new quote. The same `Idempotency-Key` always returns the same order.
3. **Stock is reserved** with conditional updates, so the last kilo can never be sold twice.
4. **Per-farm fulfilment:** each farm's part is handled independently: *pending → accepted → packed → out for delivery → delivered*, or *rejected / cancelled*. Rejecting or cancelling releases stock; delivering makes the sale final.
5. **Delivery code:** a 4-digit code that only the customer sees; the farmer must enter it to mark delivery.
6. **Payments**
   - **Cash/UPI on delivery** is always available.
   - **Razorpay** appears only when its keys are set. Unpaid online orders release their stock after 15 minutes, and payments that arrive late are flagged for refund.

> Online payment is covered by integration tests against a **mocked** Razorpay API, but has not yet run against real Razorpay. Test with Razorpay **test-mode** keys before going live. Refunds are recorded as "refund due" and are not yet sent to Razorpay automatically.

## Project structure

```
src/
  config/        env (Zod-validated), db, cache, recommendation + order settings
  controllers/   HTTP in/out only
  middleware/    auth, validation, errors, rate limits, cache headers
  models/        Mongoose schemas (users, farmers, farms, products, inventory, addresses, orders, payments, deliveries)
  routes/        route wiring
  services/      business logic (recommendation engine, orders, payments, …)
  validators/    Zod request schemas
  jobs/          background jobs (unpaid-order expiry)
  scripts/       seeds, index sync, benchmark, load test
test/            API integration tests
docs/            architecture + deployment
```

## Status

All six planned phases are complete: auth, farmer onboarding, geo recommendations, marketplace pages, ordering and payments, tests, performance work, and deployment.

**Next:** admin console (farmer verification, catalogue), written reviews, notifications, farm pickup, automatic refunds.
