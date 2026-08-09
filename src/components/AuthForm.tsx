"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiClientError } from "@/lib/api-client";
import { safeRedirect } from "@/lib/safeRedirect";
import { Card, ErrorBanner, Field, buttonClass, inputClass } from "./ui";

/** Shared sign-in / sign-up form — the two differ only in endpoint and copy. */
export function AuthForm({ mode, next }: { mode: "login" | "signup"; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiClientError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isSignup = mode === "signup";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      if (isSignup) await api.signup(email, password);
      else await api.login(email, password);

      router.push(safeRedirect(next));
      // The dashboard is a client page reading from the API, but refresh() also
      // re-runs the proxy so the redirect rules see the new cookie.
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err
          : new ApiClientError(0, { code: "internal_error", message: "Something went wrong." }),
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          {isSignup ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {isSignup
            ? "Start tracking orders and settlements."
            : "Sign in to see your orders and payments."}
        </p>
      </div>

      <Card className="p-6">
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {error && (
            <>
              <ErrorBanner message={error.message} hint={error.hint} />
              {error.details && error.details.length > 0 && (
                <ul className="list-inside list-disc text-xs text-rose-700 dark:text-rose-300">
                  {error.details.map((detail) => (
                    <li key={detail.path}>{detail.message}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          <Field label="Email" htmlFor="email">
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClass}
              placeholder="you@company.com"
            />
          </Field>

          <Field
            label="Password"
            htmlFor="password"
            hint={isSignup ? "At least 8 characters." : undefined}
          >
            <input
              id="password"
              type="password"
              autoComplete={isSignup ? "new-password" : "current-password"}
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
              placeholder="••••••••"
            />
          </Field>

          <button type="submit" disabled={submitting} className={`${buttonClass} w-full`}>
            {submitting ? "Please wait…" : isSignup ? "Create account" : "Sign in"}
          </button>
        </form>
      </Card>

      <p className="mt-6 text-center text-sm text-muted">
        {isSignup ? "Already have an account? " : "No account yet? "}
        <Link
          href={isSignup ? "/login" : "/signup"}
          className="font-medium text-accent hover:underline"
        >
          {isSignup ? "Sign in" : "Sign up"}
        </Link>
      </p>
    </div>
  );
}
