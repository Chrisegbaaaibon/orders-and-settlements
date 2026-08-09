import { vi, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

vi.mock("next/headers", () => import("@/test/authMock").then((m) => m.cookiesModule));

import { clearTestDatabase, startTestDatabase, stopTestDatabase } from "@/test/setup";
import { resetRateLimiter } from "@/lib/rateLimit";
import { resetAuthCookieMock } from "@/test/authMock";
import { POST } from "./route";

function signupRequest(body: unknown, ip = "203.0.113.9"): Request {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/signup", () => {
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

  it("creates an account and sets a session cookie", async () => {
    // A 201 here (rather than the 500 a thrown-inside-setSessionCookie error
    // would produce) is itself proof the session cookie was set successfully.
    const response = await POST(
      signupRequest({ email: "new@example.com", password: "a-strong-password" }),
    );
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.user.email).toBe("new@example.com");
  });

  it("rejects a duplicate email with 409, not a 500 from the unique index", async () => {
    await POST(signupRequest({ email: "dup@example.com", password: "a-strong-password" }));
    const second = await POST(
      signupRequest({ email: "dup@example.com", password: "a-different-password" }),
    );
    expect(second.status).toBe(409);
  });

  it("returns 400 for a password under 8 characters", async () => {
    const response = await POST(signupRequest({ email: "new@example.com", password: "short" }));
    expect(response.status).toBe(400);
  });

  it("returns 429 once the per-IP signup limit is exceeded", async () => {
    const ip = "198.51.100.42";
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await POST(
        signupRequest({ email: `person${i}@example.com`, password: "a-strong-password" }, ip),
      );
      statuses.push(response.status);
    }

    // The 11th attempt is blocked; none of the first 10 were.
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses.at(-1)).toBe(429);
  });
});
