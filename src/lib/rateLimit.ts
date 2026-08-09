import { ApiError } from "./errors";

/**
 * In-memory fixed-window rate limiter, keyed by an arbitrary string.
 *
 * This coordinates within a single Node process only — it does not share
 * state across serverless instances or multiple app replicas. For this app's
 * scope (slowing down login/signup guessing against a single deployed
 * instance) that is a reasonable, dependency-free stand-in; a real
 * multi-instance production deployment needs a shared store (Redis, etc.)
 * instead — see the README's "what I would do before production" section.
 */

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

// Every distinct key (IP, email) creates a bucket that outlives its window;
// without a periodic sweep the map would grow forever under sustained
// traffic. Piggybacking the sweep on calls to `rateLimit` avoids a background
// timer, which would keep a serverless function warm for no reason.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweep = Date.now();

export interface RateLimitOptions {
  /** Attempts allowed per window before further attempts are rejected. */
  max: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry. 0 when `allowed` is true. */
  retryAfterSeconds: number;
}

export function rateLimit(key: string, { max, windowMs }: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  sweepIfDue(now);

  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count > max) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.windowStart + windowMs - now) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function sweepIfDue(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= SWEEP_INTERVAL_MS) buckets.delete(key);
  }
}

/** `rateLimit`, but throws the 429 an API route should return when exhausted. */
export function assertNotRateLimited(key: string, options: RateLimitOptions): void {
  const result = rateLimit(key, options);
  if (result.allowed) return;

  throw new ApiError("rate_limited", "Too many attempts. Try again later.", {
    hint: `Wait ${result.retryAfterSeconds} second${result.retryAfterSeconds === 1 ? "" : "s"} and retry.`,
    meta: { retryAfterSeconds: result.retryAfterSeconds },
    headers: { "Retry-After": String(result.retryAfterSeconds) },
  });
}

/** The client IP from the standard forwarding header set by Vercel and most proxies. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || "unknown";
}

/** Test-only: clear all bucket state between test cases. */
export function resetRateLimiter(): void {
  buckets.clear();
  lastSweep = Date.now();
}
