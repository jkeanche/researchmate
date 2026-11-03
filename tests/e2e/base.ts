import { test as base } from "@playwright/test";
import Redis from "ioredis";

export * from "@playwright/test";

/**
 * Every spec signs users up and in from 127.0.0.1, and the app rate-limits
 * those per IP (as it should in production). Clearing the auth counters before
 * each test keeps specs independent of how many ran before them.
 */
export const test = base.extend<{ resetAuthRateLimits: void }>({
  resetAuthRateLimits: [
    async ({}, use) => {
      const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true, maxRetriesPerRequest: 1 });
      try {
        await redis.connect();
        const keys = [...(await redis.keys("rl:register:*")), ...(await redis.keys("rl:login:*")), ...(await redis.keys("rl:verify-resend:*"))];
        if (keys.length) await redis.del(...keys);
      } finally {
        redis.disconnect();
      }
      await use();
    },
    { auto: true },
  ],
});
