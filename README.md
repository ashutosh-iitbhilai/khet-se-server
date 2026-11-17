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
| `bench` / `loadtest` | Query benchmark on a synthetic city-sized dataset · HTTP load test |

## Testing

```bash
npm test     # 78 tests: unit + API integration
```

- **How they run:** the integration tests (`test/`) drive the real Express app (Supertest) against an **in-memory MongoDB replica set**, so checkout exercises real transactions. Each test file gets its own database.
- **What they cover:**
  - auth and roles; farmer onboarding and inventory rules;
  - geo ranking, radius widening and delivery reach;
  - quotes and idempotent ordering;
  - 6 buyers racing for 3 units (no overselling) and rollback when a line sells out mid-checkout;
  - the farmer flow with delivery codes, cancellations and access control;
  - unpaid-order expiry;
  - the full Razorpay flow against a mocked Razorpay API.
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
| POST | `/api/auth/register` | – | `{ name, email, phone?, password, role: customer \| farmer }` |
| POST | `/api/auth/login` | – | Sets httpOnly cookie, also returns `token` |
| POST | `/api/auth/logout` | – | Clears cookie |
| GET | `/api/auth/me` | any | Current user (cookie or `Authorization: Bearer`) |
| PATCH | `/api/users/me` | any | Update name / phone |
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
| POST | `/api/orders/:id/pay` | customer | Start or retry online payment |
| GET | `/api/orders/farmer?view=incoming\|active\|completed` | farmer | Order queue |
| PUT | `/api/orders/:id/status` | farmer | `{ groupId, status, note?, code?, deliveryDate? }` |
| GET | `/api/payments/methods` | anyone | `{ cod: true, online: boolean }` |
| POST | `/api/payments/razorpay/verify` | customer | Browser callback verification |
| POST | `/api/payments/razorpay/webhook` | Razorpay | Raw body, `X-Razorpay-Signature` |

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
