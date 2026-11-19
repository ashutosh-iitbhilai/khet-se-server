/**
 * Workload model for one-city launch (Raipur): customers, farmers and delivery partners
 * using the real API at the same time. See docs/WORKLOAD_MODEL.md for the numbers behind it.
 *
 *   npm run workload -- setup                 # create load-test accounts, farms, listings; log everyone in
 *   npm run workload -- run --profile peak    # 1× launch peak hour, 5 min
 *   npm run workload -- run --profile stress  # 3× peak, 3 min
 *   npm run workload -- run --profile ramp    # 1× → 12× in 1-minute steps, to find the limit
 *   npm run workload -- cleanup               # remove everything the load test created
 *
 * Env: WORKLOAD_URL (default http://localhost:5058/api). Refuses non-local targets unless
 * --allow-remote. Every simulated person sends its own X-Forwarded-For address, so per-IP
 * rate limits behave as they would with real users (the API trusts one proxy hop).
 *
 * Think and travel times are compressed (seconds instead of minutes); arrival rates are not,
 * so request rates match the model while steady state is reached within a short run.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// ─── The model (one-city launch) ─────────────────────────────────────────────

export const MODEL = {
  city: { name: 'Raipur', center: { lng: 81.6296, lat: 21.2514 }, radiusKm: 12 },
  population: { customers: 500, farmers: 200, partners: 60 },
  // Peak hour (7–9 pm) = 14% of a day with 8,000 customer sessions and 1,000 orders.
  peak: { customerSessionsPerMin: 18.7 },
  customerMix: { browse: 0.625, abandon: 0.1, buy: 0.125, track: 0.15 },
  /** Share of buy/track sessions that log in from scratch (new device); the rest refresh. */
  freshLoginShare: 0.05,
  farmer: { pollSeconds: [60, 120] as [number, number], partnerShare: 0.5 },
  partner: { pollSeconds: [15, 25] as [number, number], maxActive: 2 },
  thinkSeconds: [1, 4] as [number, number],
  travelSeconds: [10, 40] as [number, number],
  profiles: {
    peak: { steps: [{ multiplier: 1, seconds: 300 }] },
    stress: { steps: [{ multiplier: 3, seconds: 180 }] },
    ramp: { steps: [1, 5, 10, 20, 30, 45, 60].map((m) => ({ multiplier: m, seconds: 60 })) },
  },
  slo: { readP95Ms: 300, writeP95Ms: 800, errorRate: 0.005 },
} as const;

type Profile = keyof typeof MODEL.profiles;

const BASE = (process.env.WORKLOAD_URL ?? 'http://localhost:5058/api').replace(/\/$/, '');
const DIR = path.resolve(process.cwd(), '.loadtest');
const SESSIONS_FILE = path.join(DIR, 'sessions.json');
const DOMAIN = 'load.khetse.test';
const PASSWORD = 'load-test-pass-1';

// ─── Small helpers ───────────────────────────────────────────────────────────

/** CPU seconds used so far by the API process (WORKLOAD_PID), from /proc. Linux only. */
function cpuSeconds(): number | null {
  const pid = process.env.WORKLOAD_PID;
  if (!pid) return null;
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
    return (Number(f[11]) + Number(f[12])) / 100; // utime + stime, in clock ticks (100/s)
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const between = ([a, b]: readonly [number, number]) => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const chance = (p: number) => Math.random() < p;
/** Exponential inter-arrival time for a Poisson process with `perMin` arrivals per minute. */
const nextArrivalMs = (perMin: number) => (-Math.log(1 - Math.random()) / perMin) * 60_000;

function randomPoint(radiusKm: number = MODEL.city.radiusKm) {
  const r = radiusKm * Math.sqrt(Math.random());
  const t = Math.random() * 2 * Math.PI;
  const { lng, lat } = MODEL.city.center;
  return { lng: +(lng + (r * Math.cos(t)) / 103.9).toFixed(5), lat: +(lat + (r * Math.sin(t)) / 110.6).toFixed(5) };
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

interface Sample {
  key: string;
  ms: number;
  status: number;
  persona: string;
  write: boolean;
  /** Expected business outcome (e.g. another partner took the job), not a failure. */
  conflict: boolean;
}

class Metrics {
  samples: Sample[] = [];
  journeys: Record<string, { ok: number; failed: number }> = {};
  business: Record<string, number> = {};
  failures: Record<string, number> = {};
  step = 1;
  stepSamples = new Map<number, Sample[]>();

  add(s: Sample) {
    this.samples.push(s);
    if (!this.stepSamples.has(this.step)) this.stepSamples.set(this.step, []);
    this.stepSamples.get(this.step)!.push(s);
  }
  journey(name: string, ok: boolean) {
    this.journeys[name] ??= { ok: 0, failed: 0 };
    this.journeys[name][ok ? 'ok' : 'failed']++;
  }
  count(name: string, n = 1) {
    this.business[name] = (this.business[name] ?? 0) + n;
  }
  fail(reason: string) {
    this.failures[reason] = (this.failures[reason] ?? 0) + 1;
  }
}

const q = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0);

function summarize(samples: Sample[], seconds: number) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => (s.status >= 500 || s.status === 0 || (s.status >= 400 && !s.conflict && s.status !== 429))).length;
  const limited = samples.filter((s) => s.status === 429).length;
  return {
    requests: samples.length,
    rps: +(samples.length / seconds).toFixed(1),
    p50: +q(ms, 0.5).toFixed(1),
    p95: +q(ms, 0.95).toFixed(1),
    p99: +q(ms, 0.99).toFixed(1),
    errors,
    errorRate: samples.length ? +(errors / samples.length).toFixed(4) : 0,
    rateLimited: limited,
    conflicts: samples.filter((s) => s.conflict).length,
  };
}

// ─── HTTP client per simulated person ────────────────────────────────────────

interface Account {
  role: 'customer' | 'farmer' | 'delivery';
  email: string;
  ip: string;
  token?: string;
  refresh?: string;
  addressId?: string;
  home?: { lng: number; lat: number };
}

const normalize = (p: string) =>
  p
    .split('?')[0]!
    .replace(/[0-9a-f]{24}/g, ':id')
    .replace(/\/products\/[a-z0-9-]+$/, '/products/:slug');

class Client {
  constructor(
    private metrics: Metrics,
    private persona: string,
    private ip: string,
    public account?: Account,
  ) {}

  async call<T = unknown>(
    method: string,
    p: string,
    opts: { body?: unknown; headers?: Record<string, string>; conflictOk?: number[]; retried?: boolean } = {},
  ): Promise<{ status: number; data: T; error?: { code?: string; message?: string } }> {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Forwarded-For': this.ip, ...opts.headers };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.account?.token) headers.Authorization = `Bearer ${this.account.token}`;
    const t = performance.now();
    let status = 0;
    let json = null as { data?: T; error?: { code?: string; message?: string } } | null;
    try {
      const res = await fetch(`${BASE}${p}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(15_000) });
      status = res.status;
      const setCookie = res.headers.get('set-cookie');
      const refresh = setCookie?.match(/khetse_refresh=([^;]+)/)?.[1];
      if (refresh && this.account) this.account.refresh = refresh;
      json = (await res.json().catch(() => null)) as typeof json;
    } catch {
      status = 0;
    }
    const ms = performance.now() - t;
    // A 401 on an expired 15-minute access token is normal: the client refreshes and retries
    // (counted as an error only if that refresh fails).
    const expired = status === 401 && !!this.account && !opts.retried && !p.startsWith('/auth/');
    const conflict = (opts.conflictOk ?? []).includes(status) || expired;
    this.metrics.add({ key: `${method} ${normalize(p)}`, ms, status, persona: this.persona, write: method !== 'GET', conflict });

    // Expired 15-minute access token: refresh once, like the web app does.
    if (status === 401 && this.account && !opts.retried && !p.startsWith('/auth/')) {
      if (await this.refreshSession()) return this.call(method, p, { ...opts, retried: true });
    }
    return { status, data: (json?.data ?? null) as T, error: json?.error };
  }

  async refreshSession() {
    if (!this.account?.refresh) return this.login();
    const r = await this.call<{ token: string }>('POST', '/auth/refresh', { headers: { Cookie: `khetse_refresh=${this.account.refresh}` } });
    if (r.status === 200) {
      this.account.token = r.data.token;
      return true;
    }
    return this.login();
  }

  async login() {
    if (!this.account) return false;
    const r = await this.call<{ token: string }>('POST', '/auth/login', { body: { email: this.account.email, password: PASSWORD } });
    if (r.status !== 200) return false;
    this.account.token = r.data.token;
    return true;
  }
}

// ─── Shared state between personas ──────────────────────────────────────────

/** Delivery codes, as the customer would tell them at the door: "orderNumber|farmName" → code. */
const codes = new Map<string, string>();
const codeKey = (orderNumber: string, farmName: string) => `${orderNumber}|${farmName}`;

// ─── Customer journeys ───────────────────────────────────────────────────────

interface Listing {
  id: string;
  minOrderQty: number;
  quantityAvailable: number;
  farm: { id: string };
  farmer: { id: string };
}

async function think() {
  await sleep(between(MODEL.thinkSeconds) * 1000);
}

async function browse(c: Client, at: { lng: number; lat: number }, depth = 1): Promise<Listing[]> {
  const ll = `lng=${at.lng}&lat=${at.lat}`;
  const recs = await c.call<Listing[]>('GET', `/recommendations/products?${ll}&limit=12`);
  await think();
  await c.call('GET', `/recommendations/farmers?${ll}&limit=8`);
  const listings = Array.isArray(recs.data) ? recs.data : [];
  for (let i = 0; i < depth; i++) {
    await think();
    const cat = pick(['leafy-greens', 'roots-tubers', 'fruiting', 'beans-pods', 'herbs', 'sun-dried']);
    await c.call('GET', `/inventory?${ll}&category=${cat}&sort=${pick(['recommended', 'distance', 'price_asc'])}`);
    if (listings.length) {
      await think();
      await c.call('GET', `/inventory/${pick(listings).id}?${ll}`);
    }
    if (chance(0.4) && listings.length) {
      await think();
      await c.call('GET', `/farmers/${pick(listings).farmer.id}?${ll}`);
    }
  }
  return listings;
}

function cartFrom(listings: Listing[]) {
  const n = 1 + Math.floor(Math.random() * 3);
  const chosen = [...listings].sort(() => Math.random() - 0.5).slice(0, n);
  return chosen
    .filter((l) => l.quantityAvailable >= l.minOrderQty)
    .map((l) => ({ listing: l.id, quantity: Math.min(l.quantityAvailable, Math.max(l.minOrderQty, 1 + Math.floor(Math.random() * 2))) }));
}

async function customerSession(kind: keyof typeof MODEL.customerMix, accounts: Account[], m: Metrics) {
  const account = kind === 'browse' || kind === 'abandon' ? undefined : pick(accounts);
  const ip = account?.ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const c = new Client(m, 'customer', ip, account);
  const at = account?.home ?? randomPoint();
  try {
    if (account) {
      // Opening the app: a returning user's session is refreshed; a few log in from scratch.
      if (chance(MODEL.freshLoginShare)) await c.login();
      else await c.refreshSession();
      await c.call('GET', '/auth/me');
    }
    if (kind === 'browse') {
      await browse(c, at, 1 + Math.floor(Math.random() * 2));
    } else if (kind === 'abandon') {
      const listings = await browse(c, at, 1);
      const items = cartFrom(listings);
      if (items.length) {
        await think();
        await c.call('POST', '/orders/quote', { body: { items, location: at } });
        await think();
        await c.call('POST', '/orders/quote', { body: { items: items.slice(0, 1), location: at } });
      }
    } else if (kind === 'buy') {
      const listings = await browse(c, at, 1);
      await c.call('GET', '/addresses');
      let items = cartFrom(listings);
      let placed = false;
      for (let attempt = 0; attempt < 2 && items.length && !placed; attempt++) {
        await think();
        const qres = await c.call<{ grandTotal: number; issues: { listing: string }[] }>('POST', '/orders/quote', { body: { items, location: at } });
        if (qres.status !== 200) break;
        const bad = new Set(qres.data.issues.map((i) => i.listing));
        if (bad.size) {
          items = items.filter((i) => !bad.has(i.listing));
          continue;
        }
        await think();
        const res = await c.call<{ order: { id: string; orderNumber: string; groups: { farmName: string; handoverCode: string }[] } }>('POST', '/orders', {
          body: { items, addressId: account!.addressId, paymentMethod: 'cod', expectedTotal: qres.data.grandTotal },
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          conflictOk: [409], // stock or price changed while the cart was open: re-quote, like the web app
        });
        if (res.status === 201) {
          placed = true;
          m.count('orders placed');
          m.count('farm groups placed', res.data.order.groups.length);
          for (const g of res.data.order.groups) codes.set(codeKey(res.data.order.orderNumber, g.farmName), g.handoverCode);
          await c.call('GET', `/orders/${res.data.order.id}`);
        } else if (res.status === 409) {
          m.count('checkout re-quoted (cart changed)');
        }
      }
      if (!placed) m.count('buy sessions without an order');
    } else {
      const mine = await c.call<{ id: string }[]>('GET', '/orders/my-orders?limit=10');
      const orders = Array.isArray(mine.data) ? mine.data : [];
      for (const o of orders.slice(0, 1 + Math.floor(Math.random() * 2))) {
        await think();
        await c.call('GET', `/orders/${o.id}`);
      }
    }
    m.journey(`customer:${kind}`, true);
  } catch (err) {
    m.journey(`customer:${kind}`, false);
    m.fail(`customer:${kind}: ${(err as Error).message}`);
  }
}

// ─── Farmer actor ────────────────────────────────────────────────────────────

interface FarmerGroup {
  id: string;
  status: string;
  farmName: string;
  deliveryMode?: string;
}
interface FarmerOrder {
  id: string;
  orderNumber: string;
  groups: FarmerGroup[];
}

async function farmerActor(account: Account, m: Metrics, until: () => boolean) {
  const c = new Client(m, 'farmer', account.ip, account);
  const deliverAt = new Map<string, number>(); // groups the farmer is delivering themself
  await sleep(Math.random() * MODEL.farmer.pollSeconds[1] * 1000); // stagger
  let polls = 0;
  while (!until()) {
    try {
      polls++;
      if (polls % 5 === 1) await c.call('GET', '/farmers/me/overview');
      const incoming = await c.call<FarmerOrder[]>('GET', '/orders/farmer?view=incoming');
      for (const o of Array.isArray(incoming.data) ? incoming.data : []) {
        for (const g of o.groups.filter((x) => x.status === 'pending')) {
          const r = await c.call('PUT', `/orders/${o.id}/status`, { body: { groupId: g.id, status: 'accepted' }, conflictOk: [409] });
          if (r.status === 200) m.count('groups accepted by farmers');
        }
      }
      const active = await c.call<FarmerOrder[]>('GET', '/orders/farmer?view=active');
      for (const o of Array.isArray(active.data) ? active.data : []) {
        for (const g of o.groups) {
          const put = (body: Record<string, unknown>) => c.call('PUT', `/orders/${o.id}/status`, { body: { groupId: g.id, ...body }, conflictOk: [409] });
          if (g.status === 'accepted') {
            await put({ status: 'packed' });
          } else if (g.status === 'packed' && g.deliveryMode !== 'partner') {
            if (chance(MODEL.farmer.partnerShare)) {
              const r = await c.call('POST', `/orders/${o.id}/groups/${g.id}/delivery-partner`, { conflictOk: [409] });
              if (r.status === 200) m.count('partner jobs requested');
            } else {
              const r = await put({ status: 'out_for_delivery' });
              if (r.status === 200) deliverAt.set(`${o.id}|${g.id}`, Date.now() + between(MODEL.travelSeconds) * 1000);
            }
          } else if (g.status === 'out_for_delivery' && g.deliveryMode !== 'partner') {
            const key = `${o.id}|${g.id}`;
            if (!deliverAt.has(key)) deliverAt.set(key, Date.now());
            if (Date.now() >= deliverAt.get(key)!) {
              const code = codes.get(codeKey(o.orderNumber, g.farmName));
              if (!code) continue; // placed before this run: skip
              const r = await put({ status: 'delivered', code });
              if (r.status === 200) {
                m.count('self deliveries completed');
                deliverAt.delete(key);
              }
            }
          }
        }
      }
    } catch (err) {
      m.fail(`farmer: ${(err as Error).message}`);
    }
    // Farmers delivering themselves check back sooner.
    const wait = deliverAt.size ? between(MODEL.travelSeconds) : between(MODEL.farmer.pollSeconds);
    await sleep(wait * 1000);
  }
}

// ─── Delivery partner actor ──────────────────────────────────────────────────

interface Job {
  id: string;
  status: string;
  orderNumber: string;
  pickup: { farmName: string };
}

async function partnerActor(account: Account, m: Metrics, until: () => boolean) {
  const c = new Client(m, 'partner', account.ip, account);
  const due = new Map<string, number>(); // job → when the next step (pickup / handover) happens
  await sleep(Math.random() * MODEL.partner.pollSeconds[1] * 1000);
  let polls = 0;
  while (!until()) {
    try {
      polls++;
      if (polls % 6 === 1) await c.call('GET', '/delivery/overview');
      const mine = await c.call<Job[]>('GET', '/delivery/jobs?view=active');
      const active = Array.isArray(mine.data) ? mine.data : [];
      for (const j of active) {
        if (!due.has(j.id)) due.set(j.id, Date.now() + between(MODEL.travelSeconds) * 1000);
        if (Date.now() < due.get(j.id)!) continue;
        if (j.status === 'assigned') {
          const r = await c.call('POST', `/delivery/jobs/${j.id}/pickup`, { conflictOk: [409] });
          if (r.status === 200) due.set(j.id, Date.now() + between(MODEL.travelSeconds) * 1000);
        } else if (j.status === 'out_for_delivery') {
          const code = codes.get(codeKey(j.orderNumber, j.pickup.farmName));
          if (!code) continue;
          const r = await c.call('POST', `/delivery/jobs/${j.id}/deliver`, { body: { code }, conflictOk: [409] });
          if (r.status === 200) {
            m.count('partner deliveries completed');
            due.delete(j.id);
          }
        }
      }
      // Job board, like the web app's 20-second auto-refresh.
      const board = await c.call<Job[]>('GET', '/delivery/jobs/available?limit=10');
      // Only jobs from orders this run placed (it knows their codes); never real or demo orders.
      const open = (Array.isArray(board.data) ? board.data : []).filter((j) => codes.has(codeKey(j.orderNumber, j.pickup.farmName)));
      if (active.length < MODEL.partner.maxActive && open.length) {
        const job = open[Math.floor(Math.random() * Math.min(3, open.length))]!; // one of the nearest
        const r = await c.call('POST', `/delivery/jobs/${job.id}/accept`, { conflictOk: [409] });
        if (r.status === 200) m.count('partner jobs accepted');
        else if (r.status === 409) m.count('accept lost to another partner');
      }
    } catch (err) {
      m.fail(`partner: ${(err as Error).message}`);
    }
    await sleep(between(MODEL.partner.pollSeconds) * 1000);
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

function loadSessions(): { customers: Account[]; farmers: Account[]; partners: Account[] } {
  if (!fs.existsSync(SESSIONS_FILE)) throw new Error('No load-test accounts. Run `npm run workload -- setup` first.');
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
}

async function run(profile: Profile) {
  const { customers, farmers, partners } = loadSessions();
  const m = new Metrics();
  const steps = MODEL.profiles[profile].steps;
  const total = steps.reduce((s, x) => s + x.seconds, 0);
  const started = Date.now();
  let stopped = false;
  const until = () => stopped;

  console.log(`Workload "${profile}" against ${BASE}: ${steps.map((s) => `${s.multiplier}×/${s.seconds}s`).join(', ')}`);
  console.log(`  ${farmers.length} farmers and ${partners.length} partners online; customer sessions arrive at ${MODEL.peak.customerSessionsPerMin}/min × multiplier\n`);

  const actors = [...farmers.map((a) => farmerActor(a, m, until)), ...partners.map((a) => partnerActor(a, m, until))];
  const sessions: Promise<void>[] = [];
  const kinds = Object.entries(MODEL.customerMix) as [keyof typeof MODEL.customerMix, number][];
  const pickKind = () => {
    let r = Math.random();
    for (const [k, share] of kinds) if ((r -= share) <= 0) return k;
    return 'browse';
  };

  const stepResults: { multiplier: number; seconds: number; apiCpuPercent: number | null; summary: ReturnType<typeof summarize> }[] = [];
  for (const [i, step] of steps.entries()) {
    m.step = i + 1;
    const cpuStart = cpuSeconds();
    const stepEnd = Date.now() + step.seconds * 1000;
    const rate = MODEL.peak.customerSessionsPerMin * step.multiplier;
    while (Date.now() < stepEnd) {
      sessions.push(customerSession(pickKind(), customers, m));
      await sleep(Math.min(nextArrivalMs(rate), stepEnd - Date.now()));
    }
    const s = summarize(m.stepSamples.get(i + 1) ?? [], step.seconds);
    const cpuEnd = cpuSeconds();
    // One Node process uses one core for JavaScript: 100% means that core is saturated.
    const apiCpuPercent = cpuStart !== null && cpuEnd !== null ? Math.round(((cpuEnd - cpuStart) / step.seconds) * 100) : null;
    stepResults.push({ multiplier: step.multiplier, seconds: step.seconds, apiCpuPercent, summary: s });
    console.log(
      `  step ${i + 1}: ${step.multiplier}× → ${s.rps} req/s · p50 ${s.p50} ms · p95 ${s.p95} ms · p99 ${s.p99} ms · errors ${s.errors} · 429s ${s.rateLimited}${apiCpuPercent !== null ? ` · API CPU ${apiCpuPercent}%` : ''}`,
    );
  }
  stopped = true;
  console.log('\n  waiting for in-flight sessions to finish…');
  await Promise.all(sessions);
  await Promise.race([Promise.all(actors), sleep(45_000)]);

  const seconds = (Date.now() - started) / 1000;
  const byKey = new Map<string, Sample[]>();
  for (const s of m.samples) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s]);
  const endpoints = [...byKey.entries()]
    .map(([key, ss]) => ({ key, write: ss[0]!.write, ...summarize(ss, seconds) }))
    .sort((a, b) => b.requests - a.requests);
  const byPersona = Object.fromEntries(['customer', 'farmer', 'partner'].map((p) => [p, summarize(m.samples.filter((s) => s.persona === p), seconds)]));
  const reads = summarize(m.samples.filter((s) => !s.write), seconds);
  const writes = summarize(m.samples.filter((s) => s.write), seconds);
  const overall = summarize(m.samples, seconds);
  const slo = {
    readP95: reads.p95 <= MODEL.slo.readP95Ms,
    writeP95: writes.p95 <= MODEL.slo.writeP95Ms,
    errorRate: overall.errorRate <= MODEL.slo.errorRate,
  };

  // Refresh tokens rotate on every use: keep the newest ones for the next run (reusing an old
  // one is treated as theft by the API and revokes that session).
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ customers, farmers, partners }, null, 1));

  const result = { profile, target: BASE, startedAt: new Date(started).toISOString(), seconds: Math.round(seconds), steps: stepResults, overall, reads, writes, byPersona, endpoints, journeys: m.journeys, business: m.business, failures: m.failures, slo };
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `results-${profile}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));

  console.log(`\n  overall ${overall.requests} requests, ${overall.rps} req/s · reads p95 ${reads.p95} ms · writes p95 ${writes.p95} ms · error rate ${(overall.errorRate * 100).toFixed(2)}%`);
  console.log(`  SLO: reads p95 ≤ ${MODEL.slo.readP95Ms} ms ${slo.readP95 ? '✓' : '✗'} · writes p95 ≤ ${MODEL.slo.writeP95Ms} ms ${slo.writeP95 ? '✓' : '✗'} · errors ≤ ${MODEL.slo.errorRate * 100}% ${slo.errorRate ? '✓' : '✗'}`);
  console.log(`  business: ${JSON.stringify(m.business)}`);
  if (Object.keys(m.failures).length) console.log(`  failures: ${JSON.stringify(m.failures)}`);
  console.log(`  details: ${file}`);
}

// ─── Setup / cleanup (direct database access) ────────────────────────────────

async function db() {
  const { connectDatabase } = await import('../config/db');
  await connectDatabase();
  const models = {
    User: (await import('../models/User')).User,
    Farmer: (await import('../models/Farmer')).Farmer,
    Farm: (await import('../models/Farm')).Farm,
    Product: (await import('../models/Product')).Product,
    Inventory: (await import('../models/Inventory')).Inventory,
    Address: (await import('../models/Address')).Address,
    DeliveryPartner: (await import('../models/DeliveryPartner')).DeliveryPartner,
    Order: (await import('../models/Order')).Order,
    Payment: (await import('../models/Payment')).Payment,
    Delivery: (await import('../models/Delivery')).Delivery,
    Session: (await import('../models/Session')).Session,
  };
  return models;
}

const loadEmail = /@load\.khetse\.test$/;

async function cleanup() {
  const m = await db();
  const users = await m.User.find({ email: loadEmail }, '_id').lean();
  const ids = users.map((u) => u._id);
  const farmers = await m.Farmer.find({ user: { $in: ids } }, '_id').lean();
  const farmerIds = farmers.map((f) => f._id);
  // Orders placed by load customers, or containing load farms.
  const orders = await m.Order.find({ $or: [{ customer: { $in: ids } }, { 'groups.farmer': { $in: farmerIds } }] }, '_id').lean();
  const orderIds = orders.map((o) => o._id);
  await Promise.all([
    m.Payment.deleteMany({ order: { $in: orderIds } }),
    m.Delivery.deleteMany({ order: { $in: orderIds } }),
    m.Inventory.deleteMany({ farmer: { $in: farmerIds } }),
    m.Farm.deleteMany({ farmer: { $in: farmerIds } }),
    m.Address.deleteMany({ user: { $in: ids } }),
    m.Session.deleteMany({ user: { $in: ids } }),
  ]);
  // Jobs from other (e.g. demo) orders that load-test partners accepted go back on the board.
  const partnerIds = (await m.DeliveryPartner.find({ user: { $in: ids } }, '_id').lean()).map((p) => p._id);
  const taken = await m.Delivery.find({ partner: { $in: partnerIds }, order: { $nin: orderIds } }).lean();
  for (const j of taken) {
    if (j.status === 'assigned') {
      await m.Delivery.updateOne({ _id: j._id }, { $set: { status: 'requested', partner: null }, $unset: { assignedAt: 1 } });
      await m.Order.updateOne({ _id: j.order, 'groups._id': j.group }, { $unset: { 'groups.$.courier': 1 } });
    }
  }
  await m.Order.deleteMany({ _id: { $in: orderIds } });
  await m.Farmer.deleteMany({ _id: { $in: farmerIds } });
  await m.DeliveryPartner.deleteMany({ user: { $in: ids } });
  await m.User.deleteMany({ _id: { $in: ids } });
  const { fixReservationDrift } = await import('../services/order/reservation-audit.service');
  const fixed = await fixReservationDrift();
  fs.rmSync(SESSIONS_FILE, { force: true });
  console.log(`Removed ${ids.length} load-test users, ${farmerIds.length} farms' data, ${orderIds.length} orders; reserved stock re-synced on ${fixed.fixed} listings.`);
  console.log('Restart the API to drop cached recommendations that still include load-test farms.');
}

async function setup() {
  const m = await db();
  if (await m.User.exists({ email: loadEmail })) {
    console.log('Load-test data exists; removing it first.');
    await cleanup();
  }
  const products = await m.Product.find({ isActive: true }).lean();
  if (!products.length) throw new Error('Catalogue is empty — run `npm run seed:catalogue` first');
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const { toPoint } = await import('../models/common');
  const P = MODEL.population;
  const DAY = 86_400_000;

  // Farmers, farms and 4–8 listings each.
  const farmerUsers = await m.User.insertMany(
    Array.from({ length: P.farmers }, (_, i) => ({ name: `Load Farmer ${i + 1}`, email: `farmer${i + 1}@${DOMAIN}`, phone: String(7000000000 + i), role: 'farmer', passwordHash })),
  );
  const farmerDocs = await m.Farmer.insertMany(
    farmerUsers.map((u, i) => ({
      user: u._id,
      bio: 'Load-test farmer',
      experienceYears: 2 + (i % 25),
      languages: ['Hindi'],
      practices: ['vermicompost'],
      profileStatus: 'verified',
      organicCertification: i % 3 === 0 ? { status: 'verified', certificateNumber: `LOAD-${i}`, issuer: 'Load test' } : { status: 'unsubmitted' },
      ratingAvg: +(3.5 + Math.random() * 1.5).toFixed(1),
      ratingCount: Math.floor(Math.random() * 120),
    })),
  );
  const farms = await m.Farm.insertMany(
    farmerDocs.map((f, i) => {
      const at = randomPoint(14);
      return {
        farmer: f._id,
        name: `Load Farm ${i + 1}`,
        city: 'raipur',
        address: { line1: 'Load test plot', village: `Gaon ${i + 1}`, district: 'Raipur', state: 'Chhattisgarh', pincode: '492001' },
        location: toPoint(at.lng, at.lat),
        images: [],
        deliveryRadiusKm: 10 + (i % 3) * 5,
        deliveryAvailable: true,
        pickupAvailable: false,
        isActive: true,
      };
    }),
  );
  const listings = farms.flatMap((farm, i) => {
    const n = 4 + Math.floor(Math.random() * 5);
    return [...products].sort(() => Math.random() - 0.5).slice(0, n).map((p) => {
      const age = Math.floor(Math.random() * 4);
      const dates =
        p.type === 'fresh'
          ? { harvestDate: new Date(Date.now() - age * DAY) }
          : { processedDate: new Date(Date.now() - age * 10 * DAY), expiryDate: new Date(Date.now() + (p.shelfLifeDays - age * 10) * DAY) };
      return {
        farmer: farmerDocs[i]!._id,
        farm: farm._id,
        product: p._id,
        productName: p.name,
        productType: p.type,
        category: p.category,
        city: 'raipur',
        farmLocation: farm.location,
        price: 20 + Math.floor(Math.random() * 80),
        unit: p.type === 'dry' ? 'packet' : p.defaultUnit,
        packSizeGrams: p.type === 'dry' ? 200 : undefined,
        quantityAvailable: 200 + Math.floor(Math.random() * 300),
        quantityReserved: 0,
        minOrderQty: 1,
        ...dates,
        packaging: p.type === 'dry' ? 'Kraft paper pouch' : undefined,
        organicClaim: i % 3 === 0,
        isActive: true,
        images: [],
      };
    });
  });
  await m.Inventory.insertMany(listings);

  // Customers with a saved address each; partners with a base and work area, online.
  const customerUsers = await m.User.insertMany(
    Array.from({ length: P.customers }, (_, i) => ({ name: `Load Customer ${i + 1}`, email: `customer${i + 1}@${DOMAIN}`, phone: String(7200000000 + i), role: 'customer', passwordHash })),
  );
  const homes = customerUsers.map(() => randomPoint(10));
  const addresses = await m.Address.insertMany(
    customerUsers.map((u, i) => ({ user: u._id, label: 'home', name: u.name, phone: u.phone, line1: `House ${i + 1}, Load Colony`, city: 'Raipur', pincode: '492001', location: toPoint(homes[i]!.lng, homes[i]!.lat), isDefault: true })),
  );
  const partnerUsers = await m.User.insertMany(
    Array.from({ length: P.partners }, (_, i) => ({ name: `Load Rider ${i + 1}`, email: `rider${i + 1}@${DOMAIN}`, phone: String(7100000000 + i), role: 'delivery', passwordHash })),
  );
  await m.DeliveryPartner.insertMany(
    partnerUsers.map((u) => {
      const base = randomPoint(10);
      return { user: u._id, vehicle: pick(['bike', 'scooter', 'bicycle']), baseLocation: toPoint(base.lng, base.lat), baseLabel: 'Load base', serviceRadiusKm: 12, isOnline: true, maxActiveJobs: 3 };
    }),
  );
  console.log(`Created ${P.farmers} farmers (${listings.length} listings), ${P.customers} customers, ${P.partners} delivery partners.`);

  // Log everyone in through the API (bcrypt cost 12, so do it in parallel batches).
  const ip = (n: number) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  const accounts: Account[] = [
    ...customerUsers.map((u, i) => ({ role: 'customer' as const, email: u.email, ip: ip(100_000 + i), addressId: String(addresses[i]!._id), home: homes[i] })),
    ...farmerUsers.map((u, i) => ({ role: 'farmer' as const, email: u.email, ip: ip(200_000 + i) })),
    ...partnerUsers.map((u, i) => ({ role: 'delivery' as const, email: u.email, ip: ip(300_000 + i) })),
  ];
  const metrics = new Metrics();
  let done = 0;
  for (let i = 0; i < accounts.length; i += 24) {
    await Promise.all(
      accounts.slice(i, i + 24).map(async (a) => {
        if (!(await new Client(metrics, 'setup', a.ip, a).login())) throw new Error(`login failed for ${a.email} — is the API running at ${BASE}?`);
        done++;
      }),
    );
  }
  const loginMs = summarize(metrics.samples, 1);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(
    SESSIONS_FILE,
    JSON.stringify({ customers: accounts.filter((a) => a.role === 'customer'), farmers: accounts.filter((a) => a.role === 'farmer'), partners: accounts.filter((a) => a.role === 'delivery') }, null, 1),
  );
  console.log(`Logged in ${done} accounts (login p50 ${loginMs.p50} ms, p95 ${loginMs.p95} ms). Sessions saved to ${path.relative(process.cwd(), SESSIONS_FILE)}.`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

async function main() {
  const [cmd = 'run'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const host = new URL(BASE).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && !process.argv.includes('--allow-remote')) {
    throw new Error(`Refusing to load-test ${host}. Pass --allow-remote if you really mean it.`);
  }
  if (cmd === 'setup') await setup();
  else if (cmd === 'cleanup') await cleanup();
  else if (cmd === 'run') {
    const i = process.argv.indexOf('--profile');
    const profile = (i > 0 ? process.argv[i + 1] : 'peak') as Profile;
    if (!(profile in MODEL.profiles)) throw new Error(`Unknown profile ${profile}. Use: ${Object.keys(MODEL.profiles).join(', ')}`);
    await run(profile);
  } else throw new Error(`Unknown command ${cmd}. Use setup, run or cleanup.`);
}

main()
  .then(async () => {
    const mongoose = (await import('mongoose')).default;
    await mongoose.disconnect();
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    const mongoose = (await import('mongoose')).default;
    await mongoose.disconnect();
  });
