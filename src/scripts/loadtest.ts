/**
 * Tiny dependency-free load test for the public read paths.
 *
 *   LOAD_URL=http://localhost:5058/api npm run loadtest
 *
 * Runs CONCURRENCY workers for DURATION seconds. Each request uses fresh coordinates
 * (cache misses) unless LOAD_SAME_POINT=1 (cache hits). Prints throughput and latency.
 */
const BASE = process.env.LOAD_URL ?? 'http://localhost:5000/api';
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 20);
const DURATION = Number(process.env.LOAD_SECONDS ?? 15);
const SAME = process.env.LOAD_SAME_POINT === '1';
const CENTER = { lng: 81.6296, lat: 21.2514 };

const paths = ['/recommendations/farmers', '/recommendations/products', '/inventory?category=leafy-greens', '/inventory?q=tom&sort=price_asc'];

function point() {
  if (SAME) return CENTER;
  const r = 12 * Math.sqrt(Math.random());
  const t = Math.random() * 2 * Math.PI;
  return { lng: CENTER.lng + (r * Math.cos(t)) / 103.9, lat: CENTER.lat + (r * Math.sin(t)) / 110.6 };
}

async function main() {
  const latencies: number[] = [];
  let errors = 0;
  const statuses = new Map<number, number>();
  const end = Date.now() + DURATION * 1000;

  const worker = async (w: number) => {
    let i = w;
    while (Date.now() < end) {
      const p = point();
      const path = paths[i++ % paths.length];
      const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}lng=${p.lng.toFixed(5)}&lat=${p.lat.toFixed(5)}`;
      const t = performance.now();
      try {
        const res = await fetch(url);
        await res.arrayBuffer();
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        if (!res.ok) errors++;
      } catch {
        errors++;
      }
      latencies.push(performance.now() - t);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));

  latencies.sort((a, b) => a - b);
  const q = (x: number) => latencies[Math.min(latencies.length - 1, Math.floor(x * latencies.length))].toFixed(1);
  console.log(
    `${SAME ? 'same point (cache hits)' : 'random points (cache misses)'} · ${CONCURRENCY} concurrent · ${DURATION}s\n` +
      `  requests ${latencies.length}  →  ${(latencies.length / DURATION).toFixed(0)} req/s\n` +
      `  latency p50 ${q(0.5)} ms · p95 ${q(0.95)} ms · p99 ${q(0.99)} ms\n` +
      `  status ${[...statuses].map(([s, n]) => `${s}×${n}`).join(' ')}  errors ${errors}`,
  );
}

main();

export {}; // module scope (no top-level imports)
