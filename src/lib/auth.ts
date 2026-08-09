import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import mongoose from "mongoose";
import { ApiError } from "./errors";

/**
 * Session handling: a signed JWT in an httpOnly, SameSite=Lax cookie.
 *
 * httpOnly keeps the token out of reach of any XSS on the page, and SameSite=Lax
 * covers CSRF for the state-changing routes (all of which are POST/PATCH/DELETE
 * and therefore not sent cross-site under Lax).
 */

export const SESSION_COOKIE = "os_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET is missing or shorter than 32 characters. Generate one with: openssl rand -base64 32",
    );
  }
  return new TextEncoder().encode(secret);
}

export interface SessionUser {
  id: string;
  email: string;
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

export async function setSessionCookie(user: SessionUser): Promise<void> {
  const token = await createSessionToken(user);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

/** Returns the signed-in user, or null when there is no valid session. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (!payload.sub || !mongoose.Types.ObjectId.isValid(payload.sub)) return null;
    return { id: payload.sub, email: String(payload.email ?? "") };
  } catch {
    // Expired or tampered token — treat as signed out rather than erroring.
    return null;
  }
}

/** Same as getSessionUser but throws the 401 an API route should return. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    throw new ApiError("unauthenticated", "You must be signed in to do that.", {
      hint: "Sign in at /login and retry the request.",
    });
  }
  return user;
}
