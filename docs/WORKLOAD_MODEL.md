# Khet Se — Workload Model (one-city launch)

This model describes how much traffic Khet Se must handle when it launches in one city (Raipur), and turns it into a load test that exercises the real API as **customers, farmers and delivery partners at the same time**.

- **Runnable:** [`src/scripts/workload.ts`](../src/scripts/workload.ts) (`npm run workload`).
- **Measured results:** [WORKLOAD_RESULTS.md](WORKLOAD_RESULTS.md).

---

## 1. Business assumptions

| Quantity | Value | Basis |
|---|---|---|
| Daily active customers | 5,000 | ~0.5% of Raipur's ~1M urban population in year one |
| Customer sessions per day | 8,000 | 1.6 sessions per active customer |
| Orders per day | 1,000 | 12.5% of sessions end in an order |
| Farms per order (groups) | 1.4 | Most baskets come from one or two farms |
| Active farmers | 200 | 5 orders/day per farmer on average |
| Delivery partners on shift at peak | 60 | Sized in §5 |
| Partner share of deliveries | 50% | Farmers deliver the rest themselves |
| Peak hour (7–9 pm) | 14% of daily traffic | Evening grocery peak |
| Average order | ₹250, cash on delivery | Razorpay is optional at launch |

### Derived peak-hour rates (1× = launch peak)

| Rate | Per hour | Per minute |
|---|---|---|
| Customer sessions | 1,120 | **18.7** |
| Orders placed | 140 | 2.3 |
| Farm groups to accept, pack and deliver | 196 | 3.3 |
| Delivery-partner jobs | 98 | 1.6 |
| Farmer queue checks (200 farmers, every 60–120 s) | ~8,000 | ~133 |
| Partner board refreshes (60 partners, every 15–25 s) | ~10,800 | ~180 |

Polling, not shopping, makes up most of the steady traffic. That is why the partner board and farmer queue are cheap indexed queries (2dsphere + status, and `groups.farmer` + `groups.status`).

---

## 2. Personas and journeys

### Customers (open model: Poisson arrivals at 18.7/min × multiplier)

| Journey | Share | What happens (API calls) |
|---|---|---|
| **Browse** | 62.5% | Guest. Recommended products and farms near a random point in the city, 1–2 rounds of category listing → product page → (40%) farmer profile |
| **Abandon cart** | 10% | Guest. Browse, then two cart quotes, no order |
| **Buy** | 12.5% | Returning customer. Opening the app: session refresh (5%: full login from a new device), `/auth/me`. Then browse, saved addresses, quote, **place order** (COD, idempotency key), view the order. A `409` (price or stock changed) re-quotes once, as the web app does |
| **Track** | 15% | Returning customer. Session refresh, my orders, 1–2 order details |

### Farmers (closed loop: 200 online, check every 60–120 s)

Each check: incoming queue → **accept** new groups → active queue → **pack** → for packed groups, **request a delivery partner (50%)** or **go out for delivery** themselves. After a simulated trip they enter the customer's **4-digit code** to mark it delivered. Every 5th check also opens the dashboard overview.

### Delivery partners (closed loop: 60 online, board refresh every 15–25 s)

Each refresh: my active jobs → **pick up** (after a simulated ride to the farm) → **deliver with the customer's code** (after the ride to the customer) → job board → **accept** one of the 3 nearest open jobs if holding fewer than 2. Every 6th refresh also opens earnings. Two partners accepting the same job is expected; the loser gets `409`, which is counted as a business outcome.

### Time compression

Think time (1–4 s) and travel time (10–40 s) are much shorter than real life (minutes). **Arrival rates are not compressed**, so in steady state the request rate is the same as the model. Fewer sessions are in flight at once, and a 3–5 minute run reaches steady state. Delivery throughput per partner in the test is therefore *higher* than reality. Fleet capacity is modelled separately in §5.

### Realism details

- **Per-person IP:** every simulated person sends its own `X-Forwarded-For` (the API trusts one proxy hop). Per-IP rate limits apply exactly as they would to real users, and none are switched off.
- **Real authentication:** 15-minute access tokens are refreshed through `/auth/refresh` when they expire, and refresh tokens rotate. Reusing an old refresh token is treated as theft and revokes the session, so the generator persists rotated tokens between runs.
- **Data volume:** 200 farms with 1,227 listings, 500 customer accounts with saved addresses spread over 10 km, 60 partners with bases and 12 km work areas, on top of the demo data.
- **Server:** the production build (`node dist/server.js`, `NODE_ENV=production`): one Node process, in-memory cache, MongoDB 4.4 standalone on the same machine.

---

## 3. Service-level objectives

| Objective | Target |
|---|---|
| Read latency, p95 | ≤ 300 ms |
| Write latency (order, status changes, job actions), p95 | ≤ 800 ms |
| Error rate (5xx, network, unexpected 4xx) | ≤ 0.5% |
| Overselling | None: reserved stock must match open orders after every run |
| Double-assigned delivery jobs | None: exactly one partner per job |

**Expected outcomes, not counted as errors:** `409` (job taken by another partner, cart changed at checkout, order already moved on) and a `401` on an expired access token that the client then refreshes.

---

## 4. Test profiles

| Profile | Load | Duration | Question it answers |
|---|---|---|---|
| `peak` | 1× (18.7 sessions/min) | 5 min | Does launch peak meet the SLOs with headroom? |
| `stress` | 3× | 3 min | Does a festival-day spike still meet the SLOs? |
| `ramp` | 1× → 5× → 10× → 20× → 30× → 45× → 60×, 1 min each | 7 min | Where is the limit of one API process, and what breaks first? |

```bash
npm run build && NODE_ENV=production PORT=5058 node dist/server.js   # in another terminal
npm run workload -- setup                                             # ~3 min: data + logins
WORKLOAD_PID=$(pgrep -f "^node dist/server.js") npm run workload -- run --profile peak
npm run workload -- run --profile stress
npm run workload -- run --profile ramp
npm run workload -- cleanup                                           # then restart the API
```

Results are written to `.loadtest/results-<profile>.json` (ignored by git): per-step and per-endpoint throughput and latency, journeys, business counters, SLO verdicts. With `WORKLOAD_PID` set, each step also reports the API process's CPU use.

---

## 5. Delivery fleet sizing (business capacity)

The load test checks that the **software** keeps up. Whether there are **enough partners** is a separate, real-world calculation, because real rides take minutes, not seconds.

| Step of one job | Minutes |
|---|---|
| Ride to the farm (≈4 km at 20 km/h in city traffic) | 12 |
| Pickup at the farm | 5 |
| Ride to the customer (average trip ≈6 km) | 18 |
| Handover with code, cash | 3 |
| **Total** | **≈38 min → 1.6 jobs per partner-hour** |

| Load | Partner jobs/hour | Partners needed on shift | Partner earnings/hour* |
|---|---|---|---|
| 1× launch peak | 98 | **≈61** | ≈₹90 |
| 3× festival peak | 294 | ≈184 | ≈₹90 |

\* Payout ₹20 + ₹6/km of trip (minimum ₹30): ≈₹56 for a 6 km trip × 1.6 jobs/hour.

**Consequences:**

- 60 partners on shift only just covers the launch peak.
- If fewer partners log on, jobs wait on the board. The farmer sees "Looking for a delivery partner…" and can cancel the request and deliver themself.
- Before scaling demand, the business needs either more partners at peak or batching (several drops per ride). The software already lets one partner hold several jobs at once (default 3).
