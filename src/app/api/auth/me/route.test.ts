import { vi, afterEach, beforeAll, describe, expect, it } from "vitest";

vi.mock("next/headers", () => import("@/test/authMock").then((m) => m.cookiesModule));

import mongoose from "mongoose";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth";
import { setAuthCookie, resetAuthCookieMock } from "@/test/authMock";
import { GET } from "./route";

describe("GET /api/auth/me", () => {
  beforeAll(() => {
    process.env.AUTH_SECRET ??= "a-throwaway-32-plus-character-test-secret";
  });

  afterEach(() => {
    resetAuthCookieMock();
  });

  it("returns { user: null } rather than a 401 when signed out", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user).toBeNull();
  });

  it("returns the signed-in user for a valid session cookie", async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const token = await createSessionToken({ id, email: "me@example.com" });
    setAuthCookie(SESSION_COOKIE, token);

    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user).toEqual({ id, email: "me@example.com" });
  });

  it("returns { user: null } for a tampered token rather than throwing", async () => {
    setAuthCookie(SESSION_COOKIE, "not-a-real-jwt");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user).toBeNull();
  });
});
