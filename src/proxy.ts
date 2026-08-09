import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

/**
 * Route protection. (In Next.js 16 this file is `proxy.ts` — the former
 * `middleware.ts`, renamed upstream; the runtime is always Node.js.)
 *
 * This only checks for the *presence* of a session cookie, to bounce signed-out
 * visitors to /login before a protected page renders. It is not the
 * authorisation boundary: the cookie is not verified here, and every API route
 * independently calls `requireUser()` and scopes its query by `userId`. A
 * forged cookie gets you a redirect you could have reached anyway, and nothing
 * else.
 */
export function proxy(request: NextRequest) {
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const { pathname } = request.nextUrl;

  const isProtectedPage = pathname.startsWith("/dashboard") || pathname.startsWith("/orders");
  const isAuthPage = pathname === "/login" || pathname === "/signup";

  if (isProtectedPage && !hasSession) {
    const url = new URL("/login", request.url);
    // Preserve where they were headed so login can return them there.
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (isAuthPage && hasSession) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/orders/:path*", "/login", "/signup"],
};
