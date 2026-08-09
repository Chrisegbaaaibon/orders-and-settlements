"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, ApiClientError } from "@/lib/api-client";
import type { OrderSummaryJson } from "@/lib/serialize";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/status";
import { formatCents } from "@/lib/money";
import {
  Card,
  EmptyState,
  ErrorBanner,
  StatusBadge,
  buttonClass,
  formatDate,
  inputClass,
  secondaryButtonClass,
} from "@/components/ui";

type Filter = OrderStatus | "all";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  ...ORDER_STATUSES.map((status) => ({
    value: status,
    label: { pending: "Pending", partially_paid: "Partially paid", paid: "Paid", overdue: "Overdue" }[
      status
    ],
  })),
];

const emptyPagination = { page: 1, pageSize: 25, total: 0, totalPages: 1 };
const emptyAggregates = {
  billedCents: 0,
  collectedCents: 0,
  outstandingCents: 0,
  overdueCents: 0,
};

export function DashboardClient() {
  const [orders, setOrders] = useState<OrderSummaryJson[]>([]);
  const [pagination, setPagination] = useState(emptyPagination);
  const [aggregates, setAggregates] = useState(emptyAggregates);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiClientError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listOrders({ status: filter, search: search.trim() || undefined, page });
      setOrders(result.orders);
      setPagination(result.pagination);
      setAggregates(result.aggregates);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err);
    } finally {
      setLoading(false);
    }
  }, [filter, search, page]);

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  // A new filter or search term invalidates the current page — e.g. page 3 of
  // "all" may not exist under "overdue" — so both setters below reset it
  // directly, rather than reacting to the change in an effect.
  function changeFilter(value: Filter) {
    setFilter(value);
    setPage(1);
  }

  function changeSearch(value: string) {
    setSearch(value);
    setPage(1);
  }

  /**
   * The summary tiles come straight from the server's `aggregates`, computed
   * over the *complete filtered set* — not just the rows on this page. Summing
   * only `orders` (the current page) would silently disagree with the number
   * a "next page" implies exists once pagination is in play.
   */
  const totals = useMemo(
    () => ({
      billed: aggregates.billedCents,
      collected: aggregates.collectedCents,
      outstanding: aggregates.outstandingCents,
      overdue: aggregates.overdueCents,
    }),
    [aggregates],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="mt-0.5 text-sm text-muted">
            {loading
              ? "Loading…"
              : `${pagination.total} order${pagination.total === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/api/orders/export" className={secondaryButtonClass} download>
            Export CSV
          </a>
          <Link href="/orders/new" className={buttonClass}>
            New order
          </Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile label="Billed" value={totals.billed} />
        <SummaryTile label="Collected" value={totals.collected} tone="positive" />
        <SummaryTile label="Outstanding" value={totals.outstanding} />
        <SummaryTile label="Overdue" value={totals.overdue} tone="negative" />
      </div>

      {error && <ErrorBanner message={error.message} hint={error.hint} />}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <div
            role="tablist"
            aria-label="Filter orders by status"
            className="flex flex-wrap gap-1"
          >
            {FILTERS.map((option) => (
              <button
                key={option.value}
                role="tab"
                aria-selected={filter === option.value}
                onClick={() => changeFilter(option.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  filter === option.value
                    ? "bg-accent text-accent-foreground"
                    : "text-muted hover:bg-background hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={search}
            onChange={(event) => changeSearch(event.target.value)}
            placeholder="Search customer…"
            aria-label="Search by customer"
            className={`${inputClass} ml-auto w-full sm:w-56`}
          />
        </div>

        {orders.length === 0 && !loading ? (
          <EmptyState
            title={filter === "all" && !search ? "No orders yet" : "Nothing matches that filter"}
            body={
              filter === "all" && !search
                ? "Create your first order to start tracking payments against it."
                : "Try a different status or clear the search."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">Customer</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Total</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Paid</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Due</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Due date</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr
                    key={order.id}
                    className="border-b border-border last:border-0 transition hover:bg-background"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/orders/${order.id}`}
                        className="font-medium hover:text-accent hover:underline"
                      >
                        {order.customer}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={order.status} isOverdue={order.isOverdue} />
                    </td>
                    <td className="tabular px-4 py-3 text-right">
                      {formatCents(order.totalCents)}
                    </td>
                    <td className="tabular px-4 py-3 text-right text-muted">
                      {formatCents(order.amountPaidCents)}
                    </td>
                    <td
                      className={`tabular px-4 py-3 text-right font-medium ${
                        order.amountDueCents > 0 && order.isOverdue
                          ? "text-rose-600 dark:text-rose-400"
                          : ""
                      }`}
                    >
                      {formatCents(order.amountDueCents)}
                    </td>
                    <td className="px-4 py-3 text-muted">{formatDate(order.dueDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <p className="text-sm text-muted">
              Page {pagination.page} of {pagination.totalPages}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={pagination.page <= 1 || loading}
                className={secondaryButtonClass}
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                disabled={pagination.page >= pagination.totalPages || loading}
                className={secondaryButtonClass}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "positive" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "negative" && value > 0
        ? "text-rose-600 dark:text-rose-400"
        : "";

  return (
    <Card className="px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`tabular mt-1 text-xl font-semibold ${toneClass}`}>{formatCents(value)}</p>
    </Card>
  );
}
