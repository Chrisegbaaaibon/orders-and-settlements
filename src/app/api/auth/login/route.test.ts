import bcrypt from "bcryptjs";
import { vi, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

vi.mock("next/headers", () => import("@/test/authMock").then((m) => m.cookiesModule));

import { clearTestDatabase, startTestDatabase, stopTestDatabase } from "@/test/setup";
import { resetRateLimiter } from "@/lib/rateLimit";
import { resetAuthCookieMock } from "@/test/authMock";
import { User } from "@/models/User";
import { DUMMY_HASH, POST } from "./route";

/**
 * The login route compares every attempt against DUMMY_HASH when the email is
 * unknown, so that response time cannot reveal whether an account exists. That
 * only works if DUMMY_HASH is a real bcrypt hash: a malformed lookalike string
 * makes bcryptjs bail out of the cost-factor key setup almost immediately,
 * which is exactly the timing gap the constant exists to close.
 */
describe("DUMMY_HASH", () => {
  it("is a structurally valid bcrypt hash at cost 12, matching the cost used at signup", () => {
    expect(DUMMY_HASH).toMatch(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
  });

  it("bcrypt can compare against it without throwing", async () => {
    await expect(bcrypt.compare("anything", DUMMY_HASH)).resolves.toBe(false);
  });

  it("takes comparable time to a real cost-12 comparison, not a near-instant reject", async () => {
    const real = await bcrypt.hash("some-real-looking-password", 12);

    const start = performance.now();
    await bcrypt.compare("guess", DUMMY_HASH);
    const dummyMs = performance.now() - start;

    const start2 = performance.now();
    await bcrypt.compare("guess", real);
    const realMs = performance.now() - start2;

    // A malformed placeholder returns in a fraction of a millisecond; a real
    // cost-12 comparison takes tens to hundreds of milliseconds. Comparing
    // against a fraction of the real timing (rather than a fixed constant)
    // keeps this robust across slower/faster CI hardware.
    expect(dummyMs).toBeGreaterThan(realMs * 0.5);
  });
});

function loginRequest(body: unknown, ip = "203.0.113.9"): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  beforeAll(async () => {
    await startTestDatabase();
    process.env.AUTH_SECRET ??= "a-throwaway-32-plus-character-test-secret";
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
    resetRateLimiter();
    resetAuthCookieMock();
  });

  it("returns 401 for wrong credentials while under the per-account limit", async () => {
    const response = await POST(
      loginRequest({ email: "nobody@example.com", password: "wrong-password" }),
    );
    expect(response.status).toBe(401);
  });

  it("logs in with the right credentials and sets the session cookie", async () => {
    await User.create({ email: "real@example.com", passwordHash: await bcrypt.hash("correct-password", 12) });

    const response = await POST(
      loginRequest({ email: "real@example.com", password: "correct-password" }),
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.user.email).toBe("real@example.com");
  });

  it("returns 401 for the right email with the wrong password", async () => {
    await User.create({ email: "real@example.com", passwordHash: await bcrypt.hash("correct-password", 12) });

    const response = await POST(
      loginRequest({ email: "real@example.com", password: "wrong-password" }),
    );
    expect(response.status).toBe(401);
  });

  it("returns 429 with a Retry-After header once the per-account limit is exceeded", async () => {
    const email = "target@example.com";
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await POST(loginRequest({ email, password: "wrong-password" }));
    }

    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toBeTruthy();
    const body = await last?.json();
    expect(body.error.code).toBe("rate_limited");
  });

  it("returns 429 once the per-IP limit is exceeded across many different emails", async () => {
    const ip = "198.51.100.7";
    let last: Response | undefined;
    for (let i = 0; i < 21; i++) {
      last = await POST(loginRequest({ email: `user${i}@example.com`, password: "wrong-password" }, ip));
    }

    expect(last?.status).toBe(429);
  });
});
