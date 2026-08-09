import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { credentialsSchema } from "@/lib/validation";
import { ApiError, validationErrorFromZod, withErrorHandling } from "@/lib/errors";
import { setSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

/** A bcrypt hash of a throwaway value, used to keep timing constant on misses. */
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.9Z1Xy0nQ0Wl0ZQ9r9r9r9r9r9r9r9ra";

export const POST = withErrorHandling(async (request: Request) => {
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) throw validationErrorFromZod(parsed.error);

  const { email, password } = parsed.data;
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
