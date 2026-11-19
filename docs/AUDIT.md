# Khet Se — Architecture Audit (Phase 1)

**Date:** 19 Nov 2026 · **Scope:** `khet-se-server` (≈5,400 lines of TypeScript in `src/`) and `khet-se-client` · **Method:** read the code, cross-checked with the existing tests (78 API + 12 web) and the query benchmark in `npm run bench`.

Each finding cites the file it was verified in. Severity:

- **Critical:** money or stock can be lost.
- **High:** correctness or security gap that real users will hit.
- **Medium:** will hurt as usage grows, or a missing safeguard.
- **Low:** cleanup.

---

## Phase 2 status (19 Nov 2026)

| Finding | Status | What changed | Tests |
|---|---|---|---|
| **C1** paid order cancelled as unpaid | **Fixed** | Before expiring an online order, the expiry job asks Razorpay (`GET /orders/{id}/payments`) and marks it paid if a payment was captured. If Razorpay is unreachable, expiry is deferred for up to 30 min past the hold. A 5-minute `reconcile-payments` job sweeps payments still `created` after 2 min (up to 48 h). A capture that lands after the order expired is recorded as `refundDue`, not lost. | `payments.test.ts` → "payment reconciliation" (3) |
| **H1** COD orders never time out | **Fixed** | Each group gets `acceptBy` (COD: at placement; online: when paid). `FARMER_ACCEPT_HOURS`, default 24. The `expire-unaccepted-orders` job (every 5 min) cancels late groups and releases stock. Both customer and farmer screens show the deadline. | `orders.test.ts` → "farmer acceptance deadline" (2) |
| **H2** sessions can't be revoked | **Fixed** | 15-min access JWT (`ACCESS_TOKEN_TTL`) plus a rotating refresh token (`<sessionId>.<secret>`, only its SHA-256 stored in `sessions`, httpOnly cookie on `/api/auth`). Reuse of a rotated token revokes the whole family; a 30 s grace window covers two tabs refreshing at once. Logout ends the session; `POST /auth/logout-all` ends every device; suspension ends all sessions and blocks refresh. The client refreshes silently on 401 (one shared refresh for concurrent requests) and has a "Sign out of all devices" button. | `auth.test.ts` → "sessions" (10); client `lib/api.test.ts` (4) |
| **H3** delivery-code brute force | **Fixed** | Wrong codes are counted atomically per group; after 5 the group is locked (`423 CODE_LOCKED`). The customer issues a new code with `POST /orders/:id/groups/:groupId/code`, which resets the counter. Farmers never receive the code or the attempt count. | `orders.test.ts` → "delivery code brute-force protection" |
| **M7** unrestricted uploads | **Partly fixed** | The Cloudinary signature now includes `allowed_formats=jpg,jpeg,png,webp`. Pasted image links are accepted only from `ALLOWED_IMAGE_HOSTS`. **Open:** file size is checked only in the browser (8 MB); enforcing it server-side needs a Cloudinary upload preset with a size limit. | `farmer.test.ts` → "photo links" |
| **L2** order number collisions | **Fixed** | Placement retries up to 3 times with a new number on a duplicate key. | covered by order tests |
| Reserved-stock drift | **Added** | `npm run reservations:check` (add `-- --fix` to repair) recomputes `quantityReserved` from open orders. An hourly job reports drift without changing anything. | `orders.test.ts` → "reserved-stock audit" |

**After Phase 2 (product work from M9):** forgot/reset password and "Continue with Google" were added (see README → API). Reset links are single-use, hashed at rest, expire in 30 minutes, never reveal whether an account exists, and end every session. Google sign-in uses the authorization-code flow with PKCE and a signed state cookie; Google accounts are linked to an existing account only when Google reports the email as verified. 14 tests.

**Still open from C1:** money owed (`refundDue > 0`) is recorded and shown to the customer, but no refund is issued through the Razorpay API yet. Someone must refund it from the Razorpay dashboard. Automating this belongs with the admin console (M9).

**Totals after Phase 2:** 96 API tests and 16 web tests, all passing.

---

## 0. Reality check against the upgrade brief

The brief describes some technology and features as already present. In the code they are not:

| Brief says | Actual state |
|---|---|
| MongoDB Atlas | Works with Atlas, but runs on a local standalone `mongod` 4.4. Checkout uses transactions only on a replica set (`utils/transaction.ts`). |
| BullMQ | **Not used.** Jobs are `setInterval` timers inside every API process (`jobs/index.ts`). |
| Redis | Optional, used only for the recommendation cache (`config/cache.ts`). |
| OSRM | Implemented for the top-k farms, **off by default** (`ROAD_DISTANCE_ENABLED`). |
| Reviews / farmer ratings | **Not built.** `ratingAvg` and `ratingCount` exist, but only seed data sets them. |
| Notifications | **Not built.** |
| Admin dashboard | **Not built.** Admin-only product endpoints exist, but there's no way to create an admin. Farmer and organic verification is done by editing the database. |
| Refresh tokens | **Not built.** One 7-day JWT. |
| Pino, OpenTelemetry, k6 | **Not used.** Console logger, no tracing, custom load-test script. |
| shadcn/ui | shadcn-*style* components written in-repo (Radix Slot/Label only). |

Plans below start from the code as it actually is.

---

## 1. What is already solid (keep)

- **Stock cannot be oversold.** Reservation is a single conditional `$inc` (`services/order/stock.service.ts`). Tested: 6 buyers race for 3 units → exactly 3 orders.
- **Checkout is idempotent and re-priced on the server.** There is an `Idempotency-Key` with a unique index, and a `PRICE_CHANGED` / `CART_CHANGED` re-quote.
- **Order state machine.** Allowed transitions per actor live in `services/order/rules.ts` (unit-tested), and each status change is one atomic conditional update.
- **Payment verification.** Razorpay checkout and webhook signatures are checked over the raw body, and payments are marked paid exactly once (`services/payments/payment.service.ts`).
- **Ownership checks.** Customers can't read other people's orders, and farmers can't touch other farmers' order groups or listings (tested).
- **Request validation.** Zod validates every request. Also in place: helmet, a CORS allow-list, bcrypt cost 12, and env vars validated at boot.
- **Queries.** Every hot query uses an index, measured with `explain`. Compound 2dsphere indexes. The recommendation joins are batched (216 → 29 ms p50 on 28,900 listings). `autoIndex` is off in production.

---

## 2. Findings

### Critical

**C1. A paid online order can be cancelled as "unpaid", with no refund recorded.**
- **Where:** `services/payments/payment.service.ts`, `jobs/index.ts`.
- **When it happens:** payment is confirmed only by the browser callback or the webhook. If the customer pays, closes the tab, and the webhook isn't delivered (not configured, endpoint down, network), nothing ever asks Razorpay.
- **Result:** after 15 minutes the expiry job cancels the order and releases the stock. The customer has been charged, `refundDue` stays 0, and nobody is alerted.
- **Applies to:** only once Razorpay keys are set.
- **Fix:** a reconciliation job that, before expiring an unpaid online order, fetches the Razorpay order's payments and marks it paid (or refund-due) first. It also sweeps `refund_pending` orders.

### High

**H1. Cash-on-delivery orders never time out.**
- **Where:** `order.service.ts:334`. The expiry sweep only selects `paymentStatus: 'pending'` (online orders).
- **Result:** a COD order that a farmer never accepts keeps its stock reserved indefinitely. Other customers see the item as "sold out" while nobody is buying it.
- **Fix:** an acceptance deadline (configurable, e.g. 24 h). After that, unaccepted groups auto-cancel and release stock, and the customer sees why.

**H2. Sessions can't be revoked.**
- **Where:** `middleware/auth.ts`, `controllers/auth.controller.ts:28`, `config/env.ts:24`.
- **What happens:** one JWT is valid for 7 days. Logout only clears the cookie. The middleware never checks the database, so a **suspended** user, or someone holding a stolen token, keeps full access until it expires.
- **Fix:** short-lived access token (≈15 min) plus a rotating refresh token stored hashed in a `sessions` collection. Logout or suspension revokes the session, and the user's status is re-checked on every refresh. The client needs a matching update (silent refresh on 401).

**H3. The 4-digit delivery code can be brute-forced.**
- **Where:** `order.service.ts:251`. There is no limit on wrong attempts.
- **Result:** a farmer could mark an undelivered *prepaid* order as "delivered" by trying codes. 10,000 combinations at the 300 req/min limit is about 34 minutes.
- **Fix:** count failed attempts per group. After 5 wrong codes, lock the group and require the customer to re-issue the code.

### Medium

**M1. Refunds are recorded, not executed.**
- **Detail:** `refund_pending` and `refundDue` are set, but no Razorpay refund API call exists. Someone has to refund manually, with no queue of what to refund.
- **Fix:** a refund job using the Razorpay refunds API, idempotent per payment.

**M2. Cache invalidation wipes everything and scales with keyspace.**
- **Where:** `config/cache.ts:48`, 9 call sites.
- **Detail:** every farmer write (one stock change) runs `SCAN MATCH rec:*` and deletes *all* recommendation entries for every location. With Redis that is O(keyspace) per write, and the hit ratio collapses as farmers grow.
- **Fix:** versioned cache keys (one `INCR` per write, O(1)), scoped per city.

**M3. Rate limits are per process.**
- **Where:** `middleware/rateLimit.ts`.
- **Detail:** in-memory store. With N instances, every limit (including the login brute-force limit) is effectively × N.
- **Fix:** a Redis store when `REDIS_URL` is set.

**M4. Background jobs have no retries or failure handling.**
- **Where:** `jobs/index.ts`.
- **Detail:** timers run in every API process, with no retry, backoff, dead-letter or visibility.
- **Fix:** BullMQ becomes justified once reconciliation, refunds and notifications exist. Redis is already supported.

**M5. Requests can't be traced.**
- **Detail:** unstructured console logs, no request/correlation IDs, no latency or cache-hit metrics. `/api/health` ignores Redis.
- **Fix:** Pino JSON logs with a request ID on every line, returned in an `X-Request-Id` header and shown in client error messages. Add basic metrics and a Redis check in health.

**M6. Inventory has no harvest batches, so freshness can be misreported.**
- **Where:** `models/Inventory.ts:80`. There is one row per farm+product with one `harvestDate`.
- **Detail:** restocking overwrites the harvest date, so older stock is shown (and ranked) as fresh.
- **Fix:** batches inside the listing (quantity, harvest/expiry date, optional price), consumed oldest-first.

**M7. Uploads are unrestricted.**
- **Where:** `services/upload.service.ts`.
- **Detail:** the signed Cloudinary upload doesn't set `allowed_formats` or a maximum file size. Farmers can also paste any https image URL, which is then loaded by customers' browsers.
- **Fix:** sign `allowed_formats=jpg,png,webp` and a size limit; allow pasted links only from approved hosts.

**M8. The uncached recommendation path is CPU-bound.**
- **Measured:** about 80 req/s per process (load test).
- **Detail:** up to 1,000 candidates are scored per request. Cache keys round coordinates to about 110 m, so few customers share a cache entry.
- **Fix:** coarser geo-cell keys (e.g. H3 resolution 8, about 0.7 km²) and a smaller candidate cap. Measure before and after.

**M9. Product gaps the brief expects.**
- Reviews: ratings are placeholders.
- Notifications.
- Admin console: verification, catalogue, users, orders.
- Password reset and email verification.

### Low

- **L1. Offset pagination.** `skip` is used in `product`, `inventory` and `order` services. Fine now; switch order history and farmer queues to cursor pagination when they grow.
- **L2. Order number collisions.** A random 5-character suffix (33M per day) that collides surfaces as a `409` instead of retrying.
- **L3. Wrong status for blocked origins.** A disallowed origin returns `500` instead of `403` (`app.ts:29`).
- **L4. Extra request on the product page.** It fetches the farmer's whole profile just to show "more from this farm" (`ListingDetailView.tsx:206`).
- **L5. Duplicated client code.** Two URL-filter hooks (`useListingFilters`, `useUrlState`) and pagination UI repeated on 4 pages.
- **L6. Sequential expiry.** The expiry job cancels groups one at a time. Fine at current volume.
- **L7. Payment amount not re-checked.** The webhook doesn't compare the captured amount with the order. Razorpay orders have a fixed amount, so the risk is low; still worth a cheap check.

---

## 3. The brief's algorithms — what is justified now

| Algorithm | Verdict | Reason |
|---|---|---|
| Geospatial discovery with MongoDB 2dsphere + two-stage OSRM refinement | **Exists** | Implemented: `$geoNear`, then OSRM for the top k only. |
| H3 cells | **Phase 4, narrow use** | Not needed for retrieval (2dsphere already indexes space). Useful as cache keys (M8) and for grouping regions in analytics and delivery. |
| Hybrid weighted ranking with Bayesian rating and hard constraints | **Exists, extend** | Add road distance, delivery feasibility and farmer reliability (from fulfilment history) once those signals exist. |
| Semantic / vector search (embeddings, HNSW) | **Not yet** | The catalogue has 19 products. Keyword search with Hindi names covers it. Revisit with Atlas Vector Search when the catalogue is large or free-text queries fail; never a custom vector database. |
| Inventory concurrency, reservations, transactions, idempotency | **Exists; fix C1, H1, H3, M6** | The core is correct and tested; the gaps are timeouts and reconciliation. |
| Demand forecasting (moving average / EWMA, depletion estimate) | **Phase 4** | Cheap, useful to farmers, and needs only delivered-order history. |
| Delivery routing (nearest-neighbour + 2-opt) | **Phase 4, per farmer** | Each farmer delivers their own orders, so ordering one farmer's daily stops is justified. Multi-vehicle VRP, Clarke–Wright and capacity models are not justified for this business model. |
| Fair allocation (LP, min-cost flow) | **Not applicable** | Customers choose the farmer; the platform never assigns orders. Revisit only if auto-assignment is added. |
| Dynamic pricing | **No** | As the brief says. |

---

## 4. Phase 2 plan (critical corrections), in dependency order

Each item is one change, tested before moving on.

1. **C1** payment reconciliation before expiry, and a `refund_pending` sweep. Razorpay calls are mocked in tests.
2. **H1** COD acceptance deadline with auto-cancel and stock release. The farmer UI shows the deadline.
3. **H3** delivery-code attempt limit and lock.
4. **H2** access + refresh tokens with revocable sessions and a suspension check. *API contract change*: the client is updated in the same step.
5. **M7** upload restrictions.
6. **Stock-reservation check:** a script/job that recomputes `quantityReserved` from open orders and reports drift (safety net for the standalone-MongoDB crash window).

Later phases:
- **Phase 3:** M2, M3, L1, L4, M8.
- **Phase 4:** batches (M6), forecasting, route ordering, H3 cache cells.
- **Phase 5:** M4, M5 (BullMQ, Pino, request IDs, metrics).
- **Phase 6:** k6 scenarios, tests and docs.
- **Separate product work:** M9 (reviews, notifications, admin console; password reset and Google sign-in are done).
