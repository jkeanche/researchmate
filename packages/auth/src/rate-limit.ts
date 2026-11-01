import { AppError } from "@researchmate/shared";
import Redis from "ioredis";

/**
 * Fixed-window rate limiter backed by Redis (shared across web instances).
 */
export interface RateLimiter {
  /** Records a hit; returns remaining attempts in the window (negative when exceeded). */
  hit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }>;
  reset(key: string): Promise<void>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis, private readonly prefix = "rl:") {}

  async hit(key: string, limit: number, windowSeconds: number) {
    const k = this.prefix + key;
    const results = await this.redis.multi().incr(k).expire(k, windowSeconds, "NX").ttl(k).exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
    return { allowed: count <= limit, remaining: limit - count, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
  }

  async reset(key: string) {
    await this.redis.del(this.prefix + key);
  }
}

/** In-process limiter for tests and single-process tooling. */
export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, limit: number, windowSeconds: number) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.hits.set(key, entry);
    }
    entry.count++;
    return { allowed: entry.count <= limit, remaining: limit - entry.count, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }

  async reset(key: string) {
    this.hits.delete(key);
  }
}

export async function enforceRateLimit(limiter: RateLimiter, key: string, limit: number, windowSeconds: number): Promise<void> {
  const r = await limiter.hit(key, limit, windowSeconds);
  if (!r.allowed) {
    const minutes = Math.max(1, Math.ceil(r.retryAfterSeconds / 60));
    throw new AppError("RATE_LIMITED", `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, {
      retryAfterSeconds: r.retryAfterSeconds,
    });
  }
}

const globalForRedis = globalThis as unknown as { __rmRedis?: Redis };

export function getRedis(): Redis {
  if (!globalForRedis.__rmRedis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    globalForRedis.__rmRedis = new Redis(url, { maxRetriesPerRequest: 3, enableOfflineQueue: true, lazyConnect: false });
  }
  return globalForRedis.__rmRedis;
}
