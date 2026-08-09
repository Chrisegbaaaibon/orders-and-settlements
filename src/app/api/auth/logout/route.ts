import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";
import { withErrorHandling } from "@/lib/errors";

export const runtime = "nodejs";

export const POST = withErrorHandling(async () => {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
});
