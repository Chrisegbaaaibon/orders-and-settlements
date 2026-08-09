import { vi, describe, expect, it } from "vitest";

vi.mock("next/headers", () => import("@/test/authMock").then((m) => m.cookiesModule));

import { SESSION_COOKIE } from "@/lib/auth";
import { setAuthCookie, resetAuthCookieMock, cookiesModule } from "@/test/authMock";
import { POST } from "./route";

describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    setAuthCookie(SESSION_COOKIE, "some-token-value");

    const response = await POST();
    expect(response.status).toBe(200);

    // clearSessionCookie sets an empty value with maxAge: 0, rather than
    // deleting the key outright — matches the browser's own "expire it" idiom.
    const jar = await cookiesModule.cookies();
    expect(jar.get(SESSION_COOKIE)?.value).toBe("");

    resetAuthCookieMock();
  });

  it("succeeds even when there was no session to clear", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
  });
});
