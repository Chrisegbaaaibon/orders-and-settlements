import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { credentialsSchema } from "@/lib/validation";
import { ApiError, validationErrorFromZod, withErrorHandling } from "@/lib/errors";
import { setSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

export const POST = withErrorHandling(async (request: Request) => {
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) throw validationErrorFromZod(parsed.error);

  const { email, password } = parsed.data;
  await connectToDatabase();

  const passwordHash = await bcrypt.hash(password, 12);

  let user;
  try {
    user = await User.create({ email, passwordHash });
  } catch (error) {
    // Rely on the unique index rather than a read-then-write check, which would
    // race two concurrent signups for the same address.
    if (isDuplicateKeyError(error)) {
      throw new ApiError("conflict", "An account with that email already exists.", {
        hint: "Sign in instead, or use a different email address.",
      });
    }
    throw error;
  }

  await setSessionCookie({ id: user._id.toString(), email: user.email });

  return NextResponse.json(
    { user: { id: user._id.toString(), email: user.email } },
    { status: 201 },
  );
});

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}
