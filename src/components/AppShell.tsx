"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { api } from "@/lib/api-client";

/** Header + page container for every signed-in page. */
export function AppShell({ email, children }: { email?: string; children: ReactNode }) {
  const router = useRouter();

  async function handleSignOut() {
    await api.logout().catch(() => undefined);
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3.5">
          <Link href="/dashboard" className="font-semibold tracking-tight">
            Orders <span className="text-muted">&amp;</span> Settlements
          </Link>
          <div className="flex items-center gap-4">
            {email && <span className="hidden text-sm text-muted sm:inline">{email}</span>}
            <button
              type="button"
              onClick={handleSignOut}
              className="text-sm font-medium text-muted transition hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </>
  );
}
