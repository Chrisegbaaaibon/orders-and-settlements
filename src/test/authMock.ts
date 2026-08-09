/**
 * Fakes `next/headers`' `cookies()` for route-handler tests.
 *
 * App Router's `cookies()` only works inside a real request/response cycle
 * (it reads request-scoped storage Next sets up per-request) — calling a
 * route handler directly, the way these tests do to exercise real HTTP
 * status codes and response shapes, has no such context and `cookies()`
 * throws. Mocking just this one Next-owned primitive with a plain in-memory
 * jar — not any of this app's own code — lets `requireUser()` /
 * `setSessionCookie()` / `clearSessionCookie()` run unmodified against a real
 * signed JWT, so the route handler under test is exercised exactly as
 * written.
 *
 * Usage, at the top of a test file (before importing the route under test,
 * since `vi.mock` calls are hoisted above imports):
 *
 *   vi.mock("next/headers", () => import("@/test/authMock").then((m) => m.cookiesModule));
 */

interface StoredCookie {
  value: string;
}

const store = new Map<string, StoredCookie>();

export const cookiesModule = {
  cookies: async () => ({
    get: (name: string) => (store.has(name) ? { name, value: store.get(name)!.value } : undefined),
    set: (name: string, value: string) => {
      store.set(name, { value });
    },
    delete: (name: string) => {
      store.delete(name);
    },
  }),
};

/** Directly set the session cookie value, bypassing an actual login request. */
export function setAuthCookie(name: string, value: string): void {
  store.set(name, { value });
}

/**
 * Sign in as the given user for the rest of the test, without going through
 * an actual login request. Requires `AUTH_SECRET` to already be set — the
 * same JWT-signing path `POST /api/auth/login` uses on success.
 */
export async function signInAs(user: { id: string; email: string }): Promise<void> {
  const { SESSION_COOKIE, createSessionToken } = await import("@/lib/auth");
  setAuthCookie(SESSION_COOKIE, await createSessionToken(user));
}

/** Clear all cookie state between test cases. */
export function resetAuthCookieMock(): void {
  store.clear();
}
