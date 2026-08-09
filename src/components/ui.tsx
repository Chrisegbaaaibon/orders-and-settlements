import type { ReactNode } from "react";
import type { OrderStatus } from "@/lib/status";

/** Shared presentational primitives. Kept in one file — there are few enough
 *  that separate modules would be more navigation than they save. */

export function StatusBadge({ status, isOverdue }: { status: OrderStatus; isOverdue?: boolean }) {
  const styles: Record<OrderStatus, string> = {
    pending: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    partially_paid: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    paid: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    overdue: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  };

  const labels: Record<OrderStatus, string> = {
    pending: "Pending",
    partially_paid: "Partially paid",
    paid: "Paid",
    overdue: "Overdue",
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
      >
        {labels[status]}
      </span>
      {/* An order can be both partially paid and late; `status` can only say one
          of those, so the second fact gets its own marker. */}
      {isOverdue && status !== "overdue" && (
        <span className="text-xs font-medium text-rose-600 dark:text-rose-400">late</span>
      )}
    </span>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-surface ${className}`}>{children}</div>
  );
}

export function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-60";

export const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium transition hover:bg-background disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Error banner. Renders `hint` on its own line because the resolution step is
 * usually more useful than the failure itself.
 */
export function ErrorBanner({ message, hint }: { message: string; hint?: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200"
    >
      <p className="font-medium">{message}</p>
      {hint && <p className="mt-0.5 text-rose-700 dark:text-rose-300/90">{hint}</p>}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-6 py-16 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted">{body}</p>
    </div>
  );
}

/** Format an ISO date for display, in UTC — due dates are day-granular and
 *  stored at UTC midnight, so rendering them in local time would show the
 *  previous day for anyone west of Greenwich. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
