import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

/**
 * Tiny JSON cache. Uses Redis when REDIS_URL is set (shared across horizontally scaled
 * API instances), otherwise an in-process LRU-ish map. Cache failures never fail a request.
 */
interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delPrefix(prefix: string): Promise<void>;
}

class MemoryStore implements CacheStore {
  private map = new Map<string, { value: string; expires: number }>();
  constructor(private maxEntries = 2000) {}

  async get(key: string) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    if (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }
  async delPrefix(prefix: string) {
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }
}

class RedisStore implements CacheStore {
  constructor(private client: Redis) {}
  async get(key: string) {
    return this.client.get(key);
  }
  async set(key: string, value: string, ttlSeconds: number) {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }
  async delPrefix(prefix: string) {
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length) await this.client.del(...keys);
    } while (cursor !== '0');
  }
}

let store: CacheStore = new MemoryStore();

export function initCache() {
  if (!env.REDIS_URL) {
    logger.info('Cache: in-memory (set REDIS_URL to share cache across instances)');
    return;
  }
  const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  client.on('ready', () => logger.info('Cache: Redis connected'));
  client.on('error', (err) => logger.warn(`Redis error: ${err.message}`));
  store = new RedisStore(client);
}

const PREFIX = 'khetse:';

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await store.get(PREFIX + key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  async set(key: string, value: unknown, ttlSeconds: number) {
    try {
      await store.set(PREFIX + key, JSON.stringify(value), ttlSeconds);
    } catch {
      /* cache is best-effort */
    }
  },
  async invalidate(prefix: string) {
    try {
      await store.delPrefix(PREFIX + prefix);
    } catch {
      /* best-effort */
    }
  },
};

/** Drops cached recommendation results. Called after any farm / listing change so customers see updates immediately. */
export const invalidateRecommendations = () => cache.invalidate('rec:');
