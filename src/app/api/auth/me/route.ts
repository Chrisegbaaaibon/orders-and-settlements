import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { withErrorHandling } from "@/lib/errors";

export const runtime = "nodejs";

/** Returns `{ user: null }` rather than a 401 so the client can branch on it cheaply. */
export const GET = withErrorHandling(async () => {
  const user = await getSessionUser();
  return NextResponse.json({ user });
});
