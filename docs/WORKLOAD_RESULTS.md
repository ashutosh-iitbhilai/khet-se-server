# Khet Se — Workload Test Results

**Date:** 19 Nov 2026 · **Model:** [WORKLOAD_MODEL.md](WORKLOAD_MODEL.md) · **Tool:** `npm run workload`

**Environment:**
- One API process from the production build (`NODE_ENV=production`, Node 18, in-memory cache).
- MongoDB 4.4 standalone and the load generator on the same 12-core laptop with 16 GB RAM.
- Data: 200 load-test farms (1,218 listings) plus 8 demo farms, 500 customers, 60 delivery partners, plus the demo orders.

## Summary

| Profile | Load | Throughput | Reads p95 | Writes p95 | Errors | API CPU | SLOs |
|---|---|---|---|---|---|---|---|
| **peak** | 1× launch peak, 5 min | 13.3 req/s (11.4 incl. drain) | **20 ms** | **31 ms** | **0** | 12% | ✓ all |
| **stress** | 3×, 3 min | 17.0 req/s (12.6 incl. drain) | **28 ms** | **33 ms** | **0** | 16% | ✓ all |
| **ramp** | 1× → 60×, 1 min steps | up to 137 req/s | see below | see below | 0 server errors | up to 106% | ✓ up to 45× |

**Correctness after every run:**
- Reserved stock matches open orders.
- No negative stock.
- No delivery job was ever held by two partners, and every assigned job's courier matches its partner.
- Concurrent accepts were resolved correctly: the losing partner always got `409`.

## Capacity ramp (one API process)

| Load | Offered req/s | p50 | p95 | p99 | API CPU (one core) |
|---|---|---|---|---|---|
| 1× | 16 | 9 ms | 22 ms | 39 ms | 16% |
| 5× | 26 | 9 ms | 31 ms | 181 ms | 28% |
| 10× | 37 | 11 ms | 40 ms | 236 ms | 41% |
| 20× | 52 | 13 ms | 59 ms | 272 ms | 62% |
| 30× | 70 | 12 ms | 102 ms | 263 ms | 68% |
| **45×** | **104** | 14 ms | **152 ms** | 299 ms | 83% |
| 60× | 137 | 33 ms | **605 ms ✗** | 1,007 ms | **106%, saturated** |

**Limit:**
- One process keeps reads under 300 ms p95 up to **≈45× the launch peak** (≈100 req/s of this traffic mix).
- At 60×, its single JavaScript core saturates and latency climbs steeply.
- During the ramp: 3,199 customer sessions (2,029 browse, 304 abandoned carts, 411 orders, 455 tracking), with **no failed journey**.

**Slowest endpoints at the top of the ramp (p95):**

| Endpoint | p95 |
|---|---|
| login | 812 ms |
| place order | 564 ms |
| farmer profile | 428 ms |
| product page | 385 ms |
| recommendations | 359 ms |

## Findings and recommendations

1. **Password hashing blocks the server (high).**
   - `bcryptjs` is pure JavaScript, so each login holds the event loop for ≈230 ms.
   - 24 simultaneous logins took **5.7 s each**, and logins were the slowest call in the ramp.
   - A burst of logins (a morning SMS campaign, say) would stall every other request.
   - **Fix:** switch to native `bcrypt` (hashing runs on libuv's thread pool) or `argon2`. One-line change in `auth.service.ts` and `User.ts`.
2. **Scale out before ≈45× the launch peak.**
   - Node uses one core per process. Run one API process per core (PM2 cluster or several containers behind the load balancer) and set `REDIS_URL`, so cache and rate limits are shared.
   - Expected ≈8–10× more headroom on this hardware.
3. **Polling is most of the steady load.**
   - At 1×, partners refreshing the job board (≈50%) and farmers checking orders (≈38%) outweigh shoppers (≈15%).
   - Both are cheap today: p95 under 20 ms, indexed. If they grow, replace polling with push (server-sent events or WebSocket) or lengthen the refresh interval.
4. **Delivery-partner supply is the real bottleneck, not software.**
   - In the ramp, farmers requested 264 partner jobs, but partners (capped at 2 active jobs each, plus ride time) accepted 76.
   - With real ride times, 60 partners only just cover 1× (≈98 jobs/h); 3× needs ≈184 (see the fleet sizing in the model).
   - Options: more partners at peak, batching several drops per ride, and alerting farmers when a request waits more than N minutes.
5. **Refresh-token reuse detection works under load.**
   - When the load generator replayed stale refresh tokens, the API revoked those sessions every time (43 of 43), as designed.
   - The generator now saves rotated tokens between runs, so this no longer appears in the results.

## Reproduce

```bash
npm run build && NODE_ENV=production PORT=5058 node dist/server.js        # terminal 1
npm run workload -- setup                                                  # terminal 2
WORKLOAD_PID=$(pgrep -f "^node dist/server.js") npm run workload -- run --profile peak
WORKLOAD_PID=$(pgrep -f "^node dist/server.js") npm run workload -- run --profile stress
WORKLOAD_PID=$(pgrep -f "^node dist/server.js") npm run workload -- run --profile ramp
npm run workload -- cleanup
```

Raw results (per step, per endpoint, journeys, business counters): `.loadtest/results-<profile>.json`.
