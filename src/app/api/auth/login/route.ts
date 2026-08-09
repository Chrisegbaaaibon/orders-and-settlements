import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { credentialsSchema } from "@/lib/validation";
import { ApiError, validationErrorFromZod, withErrorHandling } from "@/lib/errors";
import { setSessionCookie } from "@/lib/auth";
import { assertNotRateLimited, clientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

/**
 * A real bcrypt hash (cost 12, matching signup — see signup/route.ts and
 * scripts/seed.mjs) of a throwaway value never used as an actual password.
 * Used to keep comparison timing constant for an unknown email.
 *
 * Must be a structurally valid hash, not a placeholder string: bcrypt's
 * comparison time is dominated by the cost-factor key setup embedded in the
 * hash itself, which a malformed string skips near-instantly — that would
 * make unknown emails return faster than known ones, the exact thing this
 * constant exists to prevent. Exported so that failure mode has a test.
 */
export const DUMMY_HASH = "$2b$12$Gi4MCCxhtFzNz/xyDFLLEOqyhyZWodtU2nbjtmu/7c/r5y/AOdSBW";

export const POST = withErrorHandling(async (request: Request) => {
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) throw validationErrorFromZod(parsed.error);

  const { email, password } = parsed.data;

  // Two dimensions: an IP guessing across many emails, and repeated guesses
  // against one account from anywhere. Either alone misses the other attack.
  assertNotRateLimited(`login:ip:${clientIp(request)}`, { max: 20, windowMs: 5 * 60_000 });
  assertNotRateLimited(`login:account:${email}`, { max: 5, windowMs: 15 * 60_000 });

  await connectToDatabase();

  const user = await User.findOne({ email });

  // Always run a comparison, even for an unknown email, so response time does
  // not reveal which addresses have accounts.
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !ok) {
    throw new ApiError("unauthenticated", "Email or password is incorrect.", {
      hint: "Check your credentials, or sign up if you do not have an account yet.",
    });
  }

  await setSessionCookie({ id: user._id.toString(), email: user.email });

  return NextResponse.json({ user: { id: user._id.toString(), email: user.email } });
});
