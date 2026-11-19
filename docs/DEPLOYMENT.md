# Deploying Khet Se

Two independent apps plus managed data services:

```
 Browser ──HTTPS──▶  web  (Next.js, khet-se-client)        ──┐
    │                                                    │ server-side fetches (API_INTERNAL_URL)
    └──────HTTPS──▶  api  (Express, khet-se-server) × N  ◀─────┘
                        │            │
                  MongoDB (replica set)   Redis (optional, recommended for N > 1)
                        │
  External: Cloudinary (photos) · Razorpay (payments) · OpenStreetMap Nominatim (geocoding) · OSRM (optional)
```

The API is stateless (JWT auth, no in-process sessions), so it scales by running more instances behind a load balancer.

---

## 1. Services you need

| Service | Why | Notes |
|---|---|---|
| **MongoDB replica set** (e.g. Atlas) | Data + geospatial queries + checkout transactions | Must be a replica set for multi-document transactions. On a standalone server checkout still can't oversell, but falls back to compensating writes (logged at startup). MongoDB 4.4+; 6/7 recommended. |
| **Node.js 20 host** for the API | REST API | Any container host (Render, Railway, Fly.io, ECS, Kubernetes) or a VM. `Dockerfile` (this repo) is provided. |
| **Next.js host** for the web | Customer + farmer UI | Vercel, or any Node/container host with `Dockerfile` in khet-se-client (standalone output). |
| Redis *(optional)* | Shared recommendation cache across API instances | Without it each instance keeps its own in-memory cache, which is fine for one instance. |
| Cloudinary *(optional)* | Farmers upload photos directly from the browser (signed uploads) | Without it farmers paste image links. |
| Razorpay *(optional)* | Online payments | Without it checkout offers cash/UPI on delivery only. |

## 2. Domains and cookies (read this first)

The API sets an **httpOnly auth cookie**. Put both apps on the **same site** (same registrable domain), for example:

- web: `https://khetse.in`
- api: `https://api.khetse.in`

Subdomains of one domain are the same *site*, so `COOKIE_SAMESITE=lax` with `COOKIE_SECURE=true` works, and browsers won't block it as a third-party cookie.

If the apps must live on unrelated domains (e.g. `*.vercel.app` + `*.onrender.com`), you need `COOKIE_SAMESITE=none` + `COOKIE_SECURE=true`, and some browsers will still block the cookie as third-party. Avoid that setup in production.

`CLIENT_ORIGINS` must list the exact web origin(s), e.g. `https://khetse.in,https://www.khetse.in`.

## 3. Environment variables

### API (`.env` in khet-se-server, see `.env.example`)

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `5000` (or what your host injects) |
| `MONGODB_URI` | Atlas SRV URI with a database name, e.g. `mongodb+srv://…/khet-se?retryWrites=true&w=majority` |
| `JWT_SECRET` | **required** — `openssl rand -hex 48`. Changing it signs everyone out. |
| `ACCESS_TOKEN_TTL` | `15m`: access-token lifetime. Revocation takes effect within this time. |
| `REFRESH_TOKEN_TTL_DAYS` | `30`: how long a signed-in device stays signed in without use. |
| `FARMER_ACCEPT_HOURS` | `24`: unaccepted orders are cancelled and their stock released after this. |
| `WEB_URL` / `API_PUBLIC_URL` | `https://khetse.in` / `https://api.khetse.in`: used in reset emails and the Google redirect URI |
| `EMAIL_PROVIDER` / `EMAIL_API_KEY` / `EMAIL_FROM` | `resend` or `brevo`, its API key, and a From address on a domain verified with that provider. With `log`, password-reset emails are **not sent** in production. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional. Google Cloud console → APIs & Services → Credentials → OAuth client ID (Web application). Authorised redirect URI: `https://api.khetse.in/api/auth/google/callback`. Publish the OAuth consent screen (scopes: openid, email, profile). |
| `ALLOWED_IMAGE_HOSTS` | Comma-separated hosts farmers may paste image links from (default: Cloudinary, Unsplash, Wikimedia). |
| `CLIENT_ORIGINS` | `https://khetse.in` |
| `COOKIE_SAMESITE` / `COOKIE_SECURE` | `lax` / `true` (see §2) |
| `MONGO_AUTO_INDEX` | leave unset (off in production; use `db:indexes`) |
| `REDIS_URL` | `redis://…` when running more than one API instance |
| `NOMINATIM_USER_AGENT` | Identify your deployment, e.g. `KhetSe/1.0 (ops@khetse.in)`, as the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) requires. For real traffic, run your own Nominatim or use a commercial geocoder via `NOMINATIM_URL`. |
| `ROAD_DISTANCE_ENABLED` / `OSRM_URL` | Keep `false` unless you run your own OSRM. The public demo server is for light use only. |
| `REC_DEFAULT_RADIUS_KM` / `REC_MAX_RADIUS_KM` | `8` / `25` (tune per city) |
| `CLOUDINARY_*` | From the Cloudinary dashboard (optional) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | From the Razorpay dashboard (optional). Add a webhook to `https://api.khetse.in/api/payments/razorpay/webhook` for `payment.captured` and `payment.failed`. |

### Web (`.env.local` in khet-se-client, see its `.env.example`)

| Variable | When | Value |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | **build time** (compiled into the browser bundle) | `https://api.khetse.in/api` |
| `API_INTERNAL_URL` | runtime, optional | API URL reachable from the web server (e.g. `http://api:5000/api` in Docker). Defaults to `NEXT_PUBLIC_API_URL`. |

## 4. Release procedure

Every release, in this order:

1. **CI is green.** Each repo's `.github/workflows/ci.yml` typechecks, tests and builds its app and Docker image (78 API tests on an in-memory replica set; 12 web tests).
2. **Build images**
   ```bash
   docker build -t khet-se-api .                       # in khet-se-server
   docker build -t khet-se-web --build-arg NEXT_PUBLIC_API_URL=https://api.khetse.in/api .   # in khet-se-client
   ```
3. **Apply index changes** (once per release, before the new API serves traffic):
   ```bash
   docker run --rm --env-file .env khet-se-api node dist/scripts/sync-indexes.js
   ```
   This creates new indexes and drops ones no schema declares, one collection at a time. Automatic index builds are off in production because they race between instances and deploys.
4. **First deploy only:** load the catalogue (safe to re-run later):
   ```bash
   docker run --rm --env-file .env khet-se-api node dist/scripts/seed-catalogue.js
   ```
   **Never run `seed:demo` in production.** If it was run, remove the demo farms with `npm run seed:demo -- --reset`.
5. **Roll out** the API, then the web. The API shuts down gracefully on `SIGTERM`: it stops accepting connections, finishes in-flight requests, then closes MongoDB (10 s limit). Health check: `GET /api/health` → `200` when the database is connected, `503` otherwise.
6. **Smoke test:** open the site, set a location, check nearby farms load, and place and cancel a test order with a test account.

### Docker Compose (single host / staging)

Clone `khet-se-client` next to this repo first (the compose file builds `../khet-se-client`).

```bash
JWT_SECRET=$(openssl rand -hex 48) docker compose up --build -d
docker compose run --rm api node dist/scripts/seed-catalogue.js
```

This starts MongoDB 7 as a single-node replica set (initialised by its health check), Redis, the API (syncs indexes, then starts) and the web app on <http://localhost:3000>.

> The Dockerfiles and compose file were checked here without running Docker: `docker compose config` validates, the API image's exact install/build/prune/run steps were reproduced and the server started in production mode, and the web app's standalone build was run with `node server.js`. The images themselves are first built in the CI `docker` job.

## 5. Scaling

- **API instances.** Run as many as needed; they share nothing in process.
  - **Recommendation cache:** set `REDIS_URL` so instances share it, and so a farmer's stock change clears it everywhere.
  - **Background jobs** (unpaid-order expiry) run on every instance safely: each change is an atomic conditional update.
  - **Rate limits** are per instance. With many instances, add a shared store (e.g. `rate-limit-redis`) in `src/middleware/rateLimit.ts`.
- **Measured capacity** (one Node process, 20 concurrent clients, 2,000 farms / 28,900 listings / 20,000 orders, local MongoDB):
  - **Cache misses** (a new location on every request): about 80 requests/s, p50 250 ms.
  - **Cache hits:** about 2,200 requests/s, p50 8 ms.

  The uncached path is CPU-bound (scoring up to 1,000 candidates), so throughput grows roughly linearly with instances or cores. Re-measure on your own hardware with `npm run bench` and `npm run loadtest`.
- **MongoDB.** All hot queries are index-backed (`npm run bench` prints the plans). Sharding is not needed for one city. If it ever is, `city` is the natural shard key, because every farm, listing and order already carries it.

## 6. Security checklist

- [ ] Long random `JWT_SECRET`, different per environment; secrets in your host's secret store, never in git.
- [ ] HTTPS everywhere; `COOKIE_SECURE=true`.
- [ ] `CLIENT_ORIGINS` lists only your web origins.
- [ ] MongoDB user limited to the app database; network access restricted to your API hosts; backups enabled.
- [ ] Razorpay **live** keys only in production; webhook secret set; tested end-to-end with **test-mode** keys first.
- [ ] Nominatim User-Agent identifies you (or use your own geocoder).
- [ ] No demo data (`@demo.khetse.test` accounts) in production.
- [ ] Monitoring on `/api/health`; logs collected from stdout/stderr.

## 7. Known gaps before a public launch

- **Online payments:** tested only against a mocked Razorpay API (integration tests); not yet against real Razorpay test mode.
- **Refunds** are recorded as "refund due" but not sent to Razorpay automatically. Refund them from the Razorpay dashboard.
- **Upload size** is limited only in the browser (8 MB). Add a Cloudinary upload preset with a maximum file size.
- **Not built yet:**
  - Farm pickup at checkout (delivery only).
  - SMS / email notifications.
  - Admin console (farmer verification is currently done in the database).
  - Written reviews.
- **No browser end-to-end tests** (e.g. Playwright). The UI flows were checked manually during development.
