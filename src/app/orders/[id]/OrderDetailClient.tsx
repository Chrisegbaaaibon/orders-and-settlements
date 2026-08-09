"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiClientError } from "@/lib/api-client";
import type { OrderDetailJson } from "@/lib/serialize";
import { centsToDollarString, formatCents } from "@/lib/money";
import {
  Card,
  ErrorBanner,
  Field,
  StatusBadge,
  buttonClass,
  formatDate,
  inputClass,
  secondaryButtonClass,
} from "@/components/ui";

export function OrderDetailClient({ initialOrder }: { initialOrder: OrderDetailJson }) {
  const router = useRouter();
  const [order, setOrder] = useState(initialOrder);
  const [deleteError, setDeleteError] = useState<ApiClientError | null>(null);

  async function handleDelete() {
    if (!confirm(`Delete the order for ${order.customer}? This cannot be undone.`)) return;
    setDeleteError(null);
    try {
      await api.deleteOrder(order.id);
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) setDeleteError(err);
    }
  }

  const settled = order.amountDueCents === 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">
          ← Back to orders
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{order.customer}</h1>
            <p className="mt-1 flex items-center gap-3 text-sm text-muted">
              <StatusBadge status={order.status} isOverdue={order.isOverdue} />
              <span>Due {formatDate(order.dueDate)}</span>
            </p>
          </div>
          {order.paymentCount === 0 && (
            <button type="button" onClick={handleDelete} className={secondaryButtonClass}>
              Delete
            </button>
          )}
        </div>
      </div>

      {deleteError && <ErrorBanner message={deleteError.message} hint={deleteError.hint} />}

      <div className="grid gap-3 sm:grid-cols-3">
        <AmountTile label="Order total" cents={order.totalCents} />
        <AmountTile label="Paid" cents={order.amountPaidCents} tone="positive" />
        <AmountTile
          label="Amount due"
          cents={order.amountDueCents}
          tone={order.isOverdue && order.amountDueCents > 0 ? "negative" : undefined}
        />
      </div>

      <Card>
        <h2 className="border-b border-border px-5 py-3 font-medium">Line items</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="px-5 py-2.5 font-medium">Description</th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium">Qty</th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium">Unit price</th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium">Line total</th>
              </tr>
            </thead>
            <tbody>
              {order.lineItems.map((item) => (
                <tr key={item.id} className="border-b border-border last:border-0">
                  <td className="px-5 py-3">{item.description}</td>
                  <td className="tabular px-5 py-3 text-right text-muted">{item.quantity}</td>
                  <td className="tabular px-5 py-3 text-right text-muted">
                    {formatCents(item.unitPriceCents)}
                  </td>
                  <td className="tabular px-5 py-3 text-right font-medium">
                    {formatCents(item.lineTotalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td colSpan={3} className="px-5 py-3 text-right text-sm text-muted">
                  Subtotal
                </td>
                <td className="tabular px-5 py-3 text-right font-semibold">
                  {formatCents(order.subtotalCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {!order.editable && (
          <p className="border-t border-border px-5 py-2.5 text-xs text-muted">
            Line items are locked because a payment has been recorded against this order.
          </p>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <h2 className="border-b border-border px-5 py-3 font-medium">
            Payment history{" "}
            <span className="font-normal text-muted">({order.payments.length})</span>
          </h2>
          {order.payments.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted">No payments recorded yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {order.payments.map((payment) => (
                <li key={payment.id} className="flex items-start justify-between gap-4 px-5 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{formatDate(payment.date)}</p>
                    {payment.note && (
                      <p className="mt-0.5 truncate text-sm text-muted">{payment.note}</p>
                    )}
                  </div>
                  <span className="tabular shrink-0 font-medium text-emerald-600 dark:text-emerald-400">
                    +{formatCents(payment.amountCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="lg:col-span-2">
          {settled ? (
            <Card className="p-5">
              <h2 className="font-medium">Settled</h2>
              <p className="mt-1 text-sm text-muted">
                This order is paid in full. No further payments can be recorded against it.
              </p>
            </Card>
          ) : (
            <RecordPaymentForm order={order} onRecorded={setOrder} />
          )}
        </div>
      </div>
    </div>
  );
}

function RecordPaymentForm({
  order,
  onRecorded,
}: {
  order: OrderDetailJson;
  onRecorded: (order: OrderDetailJson) => void;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [error, setError] = useState<ApiClientError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const { order: updated } = await api.recordPayment(order.id, {
        amount,
        date,
        note: note.trim() || undefined,
      });
      onRecorded(updated);
      setAmount("");
      setNote("");
      // Keeps the dashboard's cached RSC payload in step with the new balance.
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  // On an over-payment the server tells us exactly what would have fit; offer
  // that as a one-click correction rather than making the user do the subtraction.
  const suggestedCents =
    error?.code === "over_payment" && typeof error.meta?.maxAllowedCents === "number"
      ? (error.meta.maxAllowedCents as number)
      : null;

  return (
    <Card className="p-5">
      <h2 className="font-medium">Record a payment</h2>
      <p className="mt-0.5 text-sm text-muted">
        {formatCents(order.amountDueCents)} outstanding.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-3" noValidate>
        {error && (
          <div className="space-y-2">
            <ErrorBanner message={error.message} hint={error.hint} />
            {suggestedCents !== null && suggestedCents > 0 && (
              <button
                type="button"
                onClick={() => setAmount(centsToDollarString(suggestedCents))}
                className="text-xs font-medium text-accent hover:underline"
              >
                Use {formatCents(suggestedCents)} instead
              </button>
            )}
            {error.details && error.details.length > 0 && (
              <ul className="list-inside list-disc text-xs text-rose-700 dark:text-rose-300">
                {error.details.map((detail, i) => (
                  <li key={`${detail.path}-${i}`}>{detail.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Field label="Amount" htmlFor="amount">
          <input
            id="amount"
            inputMode="decimal"
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className={`${inputClass} tabular`}
            placeholder={order.amountDue}
          />
        </Field>

        <Field label="Date" htmlFor="paymentDate">
          <input
            id="paymentDate"
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Note" htmlFor="note" hint="Optional.">
          <input
            id="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className={inputClass}
            placeholder="Wire ref 88213"
          />
        </Field>

        <div className="flex gap-2">
          <button type="submit" disabled={submitting} className={`${buttonClass} flex-1`}>
            {submitting ? "Recording…" : "Record payment"}
          </button>
          <button
            type="button"
            onClick={() => setAmount(order.amountDue)}
            className={secondaryButtonClass}
          >
            Pay in full
          </button>
        </div>
      </form>
    </Card>
  );
}

function AmountTile({
  label,
  cents,
  tone,
}: {
  label: string;
  cents: number;
  tone?: "positive" | "negative";
}) {
  const toneClass =
    tone === "positive" && cents > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "negative"
        ? "text-rose-600 dark:text-rose-400"
        : "";

  return (
    <Card className="px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`tabular mt-1 text-xl font-semibold ${toneClass}`}>{formatCents(cents)}</p>
    </Card>
  );
}
