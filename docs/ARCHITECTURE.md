# Khet Se — Architecture & Design Plan

> **Repositories:** the code is split into two independent repos: **khet-se-server** (the `server/` app below, plus these docs) and **khet-se-client** (the `client/` app).

> **Khet Se** ("from the farm") — a geo-spatial, farmer-to-consumer marketplace for organic fresh and dry vegetables, starting with one city and built to grow to many.

---

## 1. Proposed Architecture

```
┌──────────────────────────┐        HTTPS / JSON (REST)        ┌──────────────────────────────┐
│  client/ (Next.js 15)    │ ───────────────────────────────▶ │  server/ (Express + TS)      │
│  App Router, React, TS   │ ◀─────────────────────────────── │  routes → controllers →      │
│  Tailwind + shadcn-style │   httpOnly JWT cookie / Bearer    │  services → models           │
└──────────────────────────┘                                   └──────┬───────────┬───────────┘
                                                                      │           │
                                                       ┌──────────────▼──┐   ┌────▼─────┐
                                                       │ MongoDB         │   │ Redis    │
                                                       │ 2dsphere, txns  │   │ cache,   │
                                                       └─────────────────┘   │ rate lim.│
                                                                             └──────────┘
             External: Cloudinary (images) · OpenStreetMap/Nominatim (geocoding) · OSRM (road distance)
```

**Principles**

- **Two independent apps.** The client never touches the database; it speaks only to the REST API (`NEXT_PUBLIC_API_URL`). Each app has its own `package.json`, `.env`, build and deploy.
- **Layered backend.** `routes` (wiring) → `validators` (Zod) → `controllers` (HTTP in/out only) → `services` (all business logic) → `models` (Mongoose). Services never see `req`/`res`.
- **Horizontally scalable API.** Each request is checked with a short-lived (15 min) JWT, so no lookup is needed per request. Refresh tokens are stored hashed in MongoDB (`sessions`), so logout, "sign out everywhere" and suspension take effect within one access-token lifetime. No session state lives in the process, so the server scales horizontally behind a load balancer. Redis is optional and degrades gracefully when absent.
- **Multi-city ready.** Every farm, address and order carries a `city` slug; geo queries are radius-bound so a city is just a data partition. Sharding is deferred until real load justifies it (shard key candidate: `city`).
- **Recommendation engine is its own service** (`services/recommendation.service.ts`) with weights in config, so it can be tuned or replaced without touching anything else.

---

## 2. Folder Structure

```
khet-se/
├── client/
│   ├── app/
│   │   ├── (shop)/                 # customer-facing pages (home, farmers, products, cart)
│   │   ├── (auth)/login, register
│   │   ├── account/                # customer dashboard
│   │   ├── farmer/                 # farmer dashboard
│   │   ├── admin/                  # admin console
│   │   ├── layout.tsx, globals.css
│   ├── components/
│   │   ├── ui/                     # button, input, card, badge … (square corners)
│   │   └── layout/                 # navbar, footer, location picker
│   ├── features/                   # auth, cart, location, farmers, products, orders
│   ├── hooks/
│   ├── lib/                        # api client, utils, constants
│   ├── services/                   # typed REST calls per resource
│   ├── types/
│   └── public/
├── server/
│   ├── src/
│   │   ├── config/                 # env (Zod-validated), db, redis, recommendation weights
│   │   ├── controllers/
│   │   ├── models/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── middleware/             # auth, validate, error, rate limit
│   │   ├── validators/
│   │   ├── utils/
│   │   ├── jobs/                   # notification / expiry jobs
│   │   ├── app.ts                  # express app (no listen — testable)
│   │   └── server.ts               # bootstrap + listen
│   ├── package.json
│   └── .env.example
├── docs/ARCHITECTURE.md
├── README.md
└── package.json                    # convenience scripts only
```

---

## 3. Database Schema (MongoDB / Mongoose)

| Collection | Key fields | Indexes |
|---|---|---|
| **users** | name, email, phone, passwordHash, role (`customer`/`farmer`/`admin`), status | `email` unique, `phone` unique sparse |
| **farmers** | user → users, displayName, bio, kycStatus, organicCertificate {number, issuer, docUrl, status}, ratingAvg, ratingCount | `user` unique |
| **farms** | farmer → farmers, name, city, address, **location: GeoJSON Point**, images[], deliveryRadiusKm, isActive, deliveryAvailable | **`location` 2dsphere**, `{city, isActive}` |
| **products** (catalogue) | name, slug, type (`fresh`/`dry`), category, defaultUnit, image, description | `slug` unique, `{type, category}`, text index on name |
| **inventory** (farmer listing) | farmer, farm, product, price, unit (`kg`/`g`/`packet`/`bunch`/`piece`), unitSize, quantityAvailable, quantityReserved, harvestDate, processedDate, expiryDate, packaging, isOrganicVerified, images[], isActive, **farmLocation (denormalised Point)** | `{farm, product}` unique, `{product, isActive, quantityAvailable}`, `farmLocation` 2dsphere |
| **addresses** | user, label, line1, city, pincode, location: Point, isDefault | `{user}` |
| **orders** | customer, orderNumber, idempotencyKey, address snapshot, **groups[]** {farmer, farm, items[] (inventory, name, price, qty, unit), subtotal, status, statusHistory[]}, totals, paymentStatus | `orderNumber` unique, `{customer, idempotencyKey}` unique, `groups.farmer` |
| **payments** | order, provider, providerRef, amount, status | `order`, `providerRef` unique sparse |
| **deliveries** | order, group, farmer, status, eta, roadDistanceKm | `{order, group}` unique |
| **reviews** | customer, farmer, product?, order, rating 1–5, comment | `{customer, order, farmer, product}` unique |

**Design notes**

- *Catalogue vs inventory:* `products` is the shared catalogue ("Tomato"); `inventory` is "Farmer A sells Tomato at ₹40/kg, 120 kg left". One product → many farmer listings.
- *Atomic stock:* reservations use a conditional update — `updateOne({_id, quantityAvailable: {$gte: qty}}, {$inc: {quantityAvailable: -qty, quantityReserved: qty}})` — inside a **transaction** with the order insert, so overselling is impossible. (Transactions need a replica set; the README shows how to run a single-node one locally.)
- *Idempotency:* the client sends an `Idempotency-Key` with checkout; the unique index rejects duplicate orders.
- *Unbounded data is never embedded:* products, orders and reviews live in their own collections, referenced by id.
- *Order groups:* one customer order may span several farmers; each `group` is fulfilled independently with its own status.

---

## 4. API Design (REST, JSON, `/api/v1`-ready under `/api`)

Responses: `{ success, data, meta? }` or `{ success: false, error: { code, message, details? } }`. Lists accept `page`, `limit` (max 50), `sort`, and return `meta: { page, limit, total, totalPages }`.

| Area | Method & path | Auth |
|---|---|---|
| Auth | `POST /api/auth/register` · `POST /api/auth/login` · `POST /api/auth/refresh` · `POST /api/auth/logout` · `POST /api/auth/logout-all` · `GET /api/auth/me` | public / any |
| Farmers | `GET /api/farmers/nearby?lng&lat&radiusKm` · `GET /api/farmers/:id` · `POST /api/farmers/profile` · `PUT /api/farmers/profile` | public / farmer |
| Farms | `GET /api/farms/mine` · `POST /api/farms` · `PUT /api/farms/:id` | farmer |
| Products (catalogue) | `GET /api/products?type&category&q` · `GET /api/products/:id` · `POST/PUT/DELETE /api/products/:id` | public / admin |
| Inventory | `GET /api/inventory?near…&product&type&maxPrice&organic` · `GET /api/inventory/mine` · `POST /api/inventory` · `PUT /api/inventory/:id` | public / farmer |
| Recommendations | `GET /api/recommendations/farmers?lng&lat` · `GET /api/recommendations/products?lng&lat` | public |
| Addresses | `GET/POST /api/addresses` · `PUT/DELETE /api/addresses/:id` | customer |
| Orders | `POST /api/orders` · `GET /api/orders/my-orders` · `GET /api/orders/farmer` · `GET /api/orders/:id` · `PUT /api/orders/:id/status` | customer / farmer |
| Reviews | `POST /api/reviews` · `GET /api/reviews?farmer&product` | customer / public |
| Uploads | `POST /api/uploads/sign` (Cloudinary signed upload) | farmer/admin |
| Admin | `GET /api/admin/stats` · `GET /api/admin/users` · `PATCH /api/admin/farmers/:id/verify` · `GET /api/admin/orders` | admin |

Status codes: 200/201/204, 400 (validation), 401, 403, 404, 409 (conflict / out of stock / duplicate), 422, 429 (rate limit), 500.

### Recommendation algorithm (hybrid weighted score)

1. `$geoNear` on `farms.location` (or `inventory.farmLocation`) with `maxDistance = radiusKm` (default 8 km, auto-expands to 15 km if fewer than N results), filter `isActive`, `deliveryAvailable`.
2. `$lookup` active inventory with stock > 0.
3. Per candidate compute normalised scores in `[0,1]`:
   - proximity `= 1 − d / radius`
   - freshness `= 1 − ageDays / shelfLifeDays` (fresh), or remaining-shelf-life ratio (dry)
   - stock `= min(1, qty / stockTarget)`
   - rating `= bayesianAvg / 5` (avoids 1 review at 5★ dominating)
   - price `= (maxPrice − price) / (maxPrice − minPrice)` within the same product
   - organic `= 1` if verified else `0`
4. `score = Σ wᵢ · sᵢ`, weights in `config/recommendation.ts` (defaults: proximity .30, freshness .20, stock .10, rating .15, price .15, organic .10). Optional OSRM road distance refines the top-k only.

---

## 5. UI Design Plan

**Brand:** *Khet Se* — fresh, natural, trustworthy, premium.

| Token | Value | Use |
|---|---|---|
| `--leaf` | `#2F6B3B` | primary actions, brand |
| `--leaf-dark` | `#1F4A28` | hover, headings on light |
| `--sprout` | `#E7F0E3` | soft green backgrounds, badges |
| `--cream` | `#FAF7F0` | page sections |
| `--sand` | `#EFE8DA` | alternate sections, dividers |
| `--soil` | `#2A2620` | body text |
| `--turmeric` | `#C98A1B` | ratings, sparing accent |

- **Square geometry everywhere — 0 px border radius** on buttons, inputs, cards, badges, images, dropdowns and modals (enforced globally in Tailwind config so no component can drift). Crisp 1 px borders + very soft shadows give definition instead of rounding.
- **Type:** *Fraunces* (serif display, warm, premium) for headings; *Inter* for UI and body.
- **Imagery:** large, realistic photographs (Indian farms, produce baskets, dried produce) cropped with `object-cover` into fixed aspect ratios (4:3 cards, 16:9 heroes) with a neutral fallback tile when a URL fails.
- **Layout:** max-width 1200 px, generous whitespace, 4-column product grid on desktop → 2 on mobile; sticky slim navbar with location chip + search.
- **Motion:** only colour/opacity transitions (150 ms). No parallax, no heavy animation.
- **States:** every data view has skeleton (loading), friendly empty state with an action, and an inline error with retry.
- **Farmer dashboard:** left sidebar with 8 plain-language items, large touch targets, one primary action per screen ("Add product"), big number inputs for price/quantity.

---

## 6. Development Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, Express server, MongoDB connection, error handling, JWT auth (register / login / logout / me), Next.js client with design system, auth pages | done |
| 2 | Farmer profile, farm registration with map pin (OSM/Leaflet), catalogue seed, inventory CRUD, image upload | done |
| 3 | `$geoNear` nearby farms, recommendation service, product filtering + ranking, Redis caching | done |
| 4 | Homepage, farmer discovery, product listing/details, farmer profile page, farmer dashboard | done |
| 5 | Cart, checkout with transaction-safe reservation, payments (Razorpay test mode), deliveries | done (Razorpay not yet tested with live test-mode keys) |
| 6 | Tests (Vitest + Supertest), query tuning, performance, deployment docs | done — see docs/DEPLOYMENT.md |
