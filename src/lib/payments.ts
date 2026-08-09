import mongoose from "mongoose";
import { Order, type OrderHydrated } from "@/models/Order";
import { ApiError } from "./errors";
import { centsToDollarString, formatCents } from "./money";

/**
 * Recording a payment — the core business rule, kept out of the route handler
 * so it can be tested against a real database without going through HTTP.
 *
 * ## Why this is one atomic update rather than read-check-write
 *
 * The obvious implementation is:
 *
 *     const order = await Order.findById(id);           // amountPaid = 400_00
 *     if (order.amountPaid + amount > order.total) throw;
 *     order.payments.push(payment);
 *     order.amountPaid += amount;
 *     await order.save();
 *
 * Two concurrent $600 payments against a $1,000 order both read amountPaid =
 * $400, both compute $1,000 <= $1,000, and both save. The order ends up paid
 * $1,600 — the exact thing the brief says must never happen.
 *
 * Instead the balance check is part of the update's filter. MongoDB evaluates
 * `$expr` against the document as it exists at write time and guarantees
 * single-document atomicity, so the two writers are serialised: the first
 * increments the total, the second re-evaluates against the new value, fails to
 * match, and is rejected. No transaction, no application-level lock.
 *
 * This is why payments are embedded in the order rather than kept in their own
 * collection — it puts the payment and the running total inside the same
 * atomicity boundary.
 */
export interface RecordPaymentInput {
  userId: string;
  orderId: string;
  amountCents: number;
  date?: Date;
  note?: string;
  /** Client-supplied retry key, e.g. an `Idempotency-Key` header. See below. */
  idempotencyKey?: string;
}

export interface RecordPaymentResult {
  order: OrderHydrated;
  payment: {
    id: string;
    amountCents: number;
    date: Date;
    note?: string;
  };
}

export async function recordPayment({
  userId,
  orderId,
  amountCents,
  date,
  note,
  idempotencyKey,
}: RecordPaymentInput): Promise<RecordPaymentResult> {
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    throw new ApiError("not_found", "Order not found.");
  }

  const ownerFilter = {
    _id: new mongoose.Types.ObjectId(orderId),
    userId: new mongoose.Types.ObjectId(userId),
  };

  /**
   * Idempotency: a client retrying after a dropped response (or a double
   * click that races itself) resends the same key. Two identical-looking
   * requests are not inherently distinguishable from "pay this order twice,
   * on purpose" — only the key says which one this is. Two reads guard it:
   *
   * 1. Before writing, check whether this key already landed. If it has,
   *    this is a replay — return the original payment rather than the
   *    balance guard's over-payment error, which would otherwise fire on a
   *    now-settled order and turn a harmless retry into a client-visible
   *    failure.
   * 2. The write's filter also excludes documents where the key is already
   *    present (`$ne`), so two copies of the same retry racing each other
   *    cannot both push a payment — the loser falls through to the
   *    "raced" re-check below instead of writing a second one.
   */
  if (idempotencyKey) {
    const replay = await findPaymentByIdempotencyKey(ownerFilter, idempotencyKey);
    if (replay) return replay;
  }

  const payment = {
    _id: new mongoose.Types.ObjectId(),
    amountCents,
    date: date ?? new Date(),
    ...(note ? { note } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    createdAt: new Date(),
  };

  const order = await Order.findOneAndUpdate(
    {
      ...ownerFilter,
      // The balance guard. Evaluated server-side against the current document.
      $expr: { $lte: [{ $add: ["$amountPaidCents", amountCents] }, "$totalCents"] },
      ...(idempotencyKey ? { "payments.idempotencyKey": { $ne: idempotencyKey } } : {}),
    },
    {
      $push: { payments: payment },
      $inc: { amountPaidCents: amountCents },
    },
    { returnDocument: "after" },
  );

  if (order) {
    return {
      order,
      payment: {
        id: payment._id.toString(),
        amountCents: payment.amountCents,
        date: payment.date,
        ...(note ? { note } : {}),
      },
    };
  }

  // Nothing matched. A concurrent copy of this same retry may have just won
  // (see point 2 above) — check for that before falling back to the
  // over-payment / not-found explanation, which reads the order anyway.
  if (idempotencyKey) {
    const replay = await findPaymentByIdempotencyKey(ownerFilter, idempotencyKey);
    if (replay) return replay;
  }

  throw await explainRejection(userId, orderId, amountCents);
}

async function findPaymentByIdempotencyKey(
  ownerFilter: { _id: mongoose.Types.ObjectId; userId: mongoose.Types.ObjectId },
  idempotencyKey: string,
): Promise<RecordPaymentResult | null> {
  const order = await Order.findOne({ ...ownerFilter, "payments.idempotencyKey": idempotencyKey });
  if (!order) return null;

  const payment = order.payments.find((p) => p.idempotencyKey === idempotencyKey);
  if (!payment) return null; // Guarded by the query above; unreachable in practice.

  return {
    order,
    payment: {
      id: payment._id.toString(),
      amountCents: payment.amountCents,
      date: payment.date,
      ...(payment.note ? { note: payment.note } : {}),
    },
  };
}

async function explainRejection(
  userId: string,
  orderId: string,
  amountCents: number,
): Promise<ApiError> {
  const order = await Order.findOne({
    _id: new mongoose.Types.ObjectId(orderId),
    userId: new mongoose.Types.ObjectId(userId),
  });

  // Not ours, or gone. Same answer either way, so an id probe cannot tell the
  // difference between "does not exist" and "belongs to someone else".
  if (!order) return new ApiError("not_found", "Order not found.");

  const maxAllowedCents = Math.max(0, order.totalCents - order.amountPaidCents);
  const settled = maxAllowedCents === 0;

  // Prose gets `formatCents` ("$1,000.00"); `meta` gets `centsToDollarString`
  // ("1000.00") so a client can parse it without stripping symbols.
  return new ApiError(
    "over_payment",
    settled
      ? `This order is already paid in full (${formatCents(order.totalCents)}). No further payment can be recorded.`
      : `Payment of ${formatCents(amountCents)} exceeds the ${formatCents(maxAllowedCents)} still outstanding on this order.`,
    {
      hint: settled
        ? "Check whether you meant to apply this payment to a different order."
        : `Record ${formatCents(maxAllowedCents)} or less.`,
      meta: {
        maxAllowedCents,
        maxAllowed: centsToDollarString(maxAllowedCents),
        attemptedCents: amountCents,
        attempted: centsToDollarString(amountCents),
        totalCents: order.totalCents,
        total: centsToDollarString(order.totalCents),
        amountPaidCents: order.amountPaidCents,
        amountPaid: centsToDollarString(order.amountPaidCents),
      },
    },
  );
}
