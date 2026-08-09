import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { assertNotRateLimited, clientIp, rateLimit, resetRateLimiter } from "./rateLimit";

beforeEach(() => {
  vi.useFakeTimers();
  resetRateLimiter();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimit", () => {
  it("allows up to max attempts within the window", () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimit("key", { max: 5, windowMs: 1_000 }).allowed).toBe(true);
    }
  });

  it("rejects the attempt after max within the same window", () => {
    for (let i = 0; i < 5; i++) rateLimit("key", { max: 5, windowMs: 1_000 });

    const result = rateLimit("key", { max: 5, windowMs: 1_000 });
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets once the window elapses", () => {
    for (let i = 0; i < 5; i++) rateLimit("key", { max: 5, windowMs: 1_000 });
    expect(rateLimit("key", { max: 5, windowMs: 1_000 }).allowed).toBe(false);

    vi.advanceTimersByTime(1_001);

    expect(rateLimit("key", { max: 5, windowMs: 1_000 }).allowed).toBe(true);
  });

  it("tracks distinct keys independently", () => {
    for (let i = 0; i < 5; i++) rateLimit("a", { max: 5, windowMs: 1_000 });
    expect(rateLimit("a", { max: 5, windowMs: 1_000 }).allowed).toBe(false);
    // A different key has its own budget, untouched by "a" being exhausted.
    expect(rateLimit("b", { max: 5, windowMs: 1_000 }).allowed).toBe(true);
  });
});

describe("assertNotRateLimited", () => {
  it("does not throw while under the limit", () => {
    expect(() => assertNotRateLimited("key", { max: 1, windowMs: 1_000 })).not.toThrow();
  });

  it("throws a rate_limited ApiError with a Retry-After header once exhausted", () => {
    assertNotRateLimited("key", { max: 1, windowMs: 1_000 });

    let caught: unknown;
    try {
      assertNotRateLimited("key", { max: 1, windowMs: 1_000 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const error = caught as ApiError;
    expect(error.code).toBe("rate_limited");
    expect(error.status).toBe(429);
    expect(error.headers?.["Retry-After"]).toBeDefined();
    expect(error.meta?.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("clientIp", () => {
  it("reads the first address from X-Forwarded-For", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(clientIp(request)).toBe("203.0.113.5");
  });

  it("falls back to 'unknown' when the header is absent", () => {
    expect(clientIp(new Request("http://localhost/"))).toBe("unknown");
  });
});
