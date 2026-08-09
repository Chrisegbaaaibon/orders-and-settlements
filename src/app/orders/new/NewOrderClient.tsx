"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiClientError, type LineItemInput } from "@/lib/api-client";
import { formatCents, parseDollarsToCents } from "@/lib/money";
import {
  Card,
  ErrorBanner,
  Field,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "@/components/ui";

const emptyLine = (): LineItemInput => ({ description: "", quantity: "1", unitPrice: "" });

/** Default due date: 7 days out, matching the brief's sample scenario. */
function defaultDueDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

export function NewOrderClient() {
  const router = useRouter();
  const [customer, setCustomer] = useState("");
  const [dueDate, setDueDate] = useState(defaultDueDate);
  const [lineItems, setLineItems] = useState<LineItemInput[]>([emptyLine()]);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * Live subtotal, computed with the same cents-based parser the server uses so
   * the preview can never disagree with the total that gets stored. Unparseable
   * rows contribute zero rather than NaN — the server is the one that rejects
   * them.
   */
  const subtotalCents = useMemo(
    () =>
      lineItems.reduce((sum, item) => {
        try {
          const quantity = Number(item.quantity);
          if (!Number.isInteger(quantity) || quantity < 1) return sum;
          return sum + quantity * parseDollarsToCents(item.unitPrice || "0");
        } catch {
          return sum;
        }
      }, 0),
    [lineItems],
  );

  function updateLine(index: number, patch: Partial<LineItemInput>) {
    setLineItems((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const { order } = await api.createOrder({ customer, dueDate, lineItems });
      router.push(`/orders/${order.id}`);
    } catch (err) {
      if (err instanceof ApiClientError) setError(err);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">
          ← Back to orders
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New order</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
        {error && (
          <div className="space-y-2">
            <ErrorBanner message={error.message} hint={error.hint} />
            {error.details && error.details.length > 0 && (
              <ul className="list-inside list-disc text-xs text-rose-700 dark:text-rose-300">
                {error.details.map((detail, i) => (
                  <li key={`${detail.path}-${i}`}>
                    <span className="font-mono">{detail.path}</span>: {detail.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Card className="space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Customer" htmlFor="customer">
              <input
                id="customer"
                required
                value={customer}
                onChange={(event) => setCustomer(event.target.value)}
                className={inputClass}
                placeholder="Acme Corp"
              />
            </Field>
            <Field label="Due date" htmlFor="dueDate" hint="When payment is expected.">
              <input
                id="dueDate"
                type="date"
                required
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium">Line items</h2>
            <button
              type="button"
              onClick={() => setLineItems((current) => [...current, emptyLine()])}
              className="text-sm font-medium text-accent hover:underline"
            >
              + Add line
            </button>
          </div>

          <div className="space-y-3">
            {lineItems.map((item, index) => (
              <div key={index} className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-12 sm:col-span-6">
                  <label className="mb-1 block text-xs text-muted" htmlFor={`desc-${index}`}>
                    Description
                  </label>
                  <input
                    id={`desc-${index}`}
                    required
                    value={item.description}
                    onChange={(event) => updateLine(index, { description: event.target.value })}
                    className={inputClass}
                    placeholder="Consulting hours"
                  />
                </div>
                <div className="col-span-4 sm:col-span-2">
                  <label className="mb-1 block text-xs text-muted" htmlFor={`qty-${index}`}>
                    Qty
                  </label>
                  <input
                    id={`qty-${index}`}
                    type="number"
                    min={1}
                    step={1}
                    required
                    value={item.quantity}
                    onChange={(event) => updateLine(index, { quantity: event.target.value })}
                    className={`${inputClass} tabular`}
                  />
                </div>
                <div className="col-span-5 sm:col-span-3">
                  <label className="mb-1 block text-xs text-muted" htmlFor={`price-${index}`}>
                    Unit price
                  </label>
                  <input
                    id={`price-${index}`}
                    inputMode="decimal"
                    required
                    value={item.unitPrice}
                    onChange={(event) => updateLine(index, { unitPrice: event.target.value })}
                    className={`${inputClass} tabular`}
                    placeholder="500.00"
                  />
                </div>
                <div className="col-span-3 sm:col-span-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setLineItems((current) => current.filter((_, i) => i !== index))}
                    disabled={lineItems.length === 1}
                    aria-label={`Remove line ${index + 1}`}
                    className="rounded-lg border border-border px-2.5 py-2 text-sm text-muted transition hover:text-rose-600 disabled:opacity-30 disabled:hover:text-muted"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
            <span className="text-sm text-muted">Order total</span>
            <span className="tabular text-lg font-semibold">{formatCents(subtotalCents)}</span>
          </div>
        </Card>

        <div className="flex justify-end gap-2">
          <Link href="/dashboard" className={secondaryButtonClass}>
            Cancel
          </Link>
          <button type="submit" disabled={submitting} className={buttonClass}>
            {submitting ? "Creating…" : "Create order"}
          </button>
        </div>
      </form>
    </div>
  );
}
