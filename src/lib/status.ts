/**
 * Order status derivation.
 *
 * Status is never stored. It is a pure function of (amount paid, order total,
 * due date, now). Storing it would mean an order that quietly crosses its due
 * date at midnight has a stale row until something writes to it; deriving it
 * means every read is correct by construction.
 *
 * See README "Status derivation rules" for the precedence rationale.
 */

export const ORDER_STATUSES = ["pending", "partially_paid", "paid", "overdue"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export interface StatusInput {
  amountPaidCents: number;
  totalCents: number;
  dueDate: Date;
  now?: Date;
}

export interface DerivedState {
  status: OrderStatus;
  /**
   * Exposed separately from `status` because the four statuses are mutually
   * exclusive but "overdue" and "partially paid" are genuinely both true at
   * once. The dashboard uses this to badge a partially-paid order as late
   * without losing the payment information.
   */
  isOverdue: boolean;
  amountDueCents: number;
}

export function deriveOrderState({
  amountPaidCents,
  totalCents,
  dueDate,
  now = new Date(),
}: StatusInput): DerivedState {
  const amountDueCents = Math.max(0, totalCents - amountPaidCents);

  // A zero-total order (all line items free) is treated as settled rather than
  // perpetually pending — there is nothing left to collect.
  const fullyPaid = amountPaidCents >= totalCents;

  // "Past due" means the due date has fully elapsed. Due dates are day-granular
  // and stored at UTC midnight, so an order due today is not late until the day
  // is over. See README for the timezone caveat.
  const pastDue = !fullyPaid && endOfDueDay(dueDate).getTime() < now.getTime();

  let status: OrderStatus;
  if (fullyPaid) {
    // Precedence: paid outranks overdue. An order that was late but has since
    // been settled in full reads as `paid` — this is the edge case called out
    // in the brief.
    status = "paid";
  } else if (pastDue) {
    status = "overdue";
  } else if (amountPaidCents > 0) {
    status = "partially_paid";
  } else {
    status = "pending";
  }

  return { status, isOverdue: pastDue, amountDueCents };
}

/** The last instant of the due date's UTC day. */
function endOfDueDay(dueDate: Date): Date {
  const d = new Date(dueDate);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}
