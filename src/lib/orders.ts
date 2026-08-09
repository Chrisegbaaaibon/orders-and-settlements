import mongoose, { type QueryFilter } from "mongoose";
import { Order, type OrderDoc, type OrderHydrated } from "@/models/Order";
import { ApiError } from "./errors";
import { centsToDollarString, computeLineTotals } from "./money";
import { deriveOrderState } from "./status";
import type { OrderAggregates } from "./serialize";
import type { SessionUser } from "./auth";

/**
 * Load an order the user owns, or throw 404.
 *
 * A row belonging to someone else returns "not found" rather than "forbidden":
 * a 403 would confirm the id exists, which leaks the size and shape of other
 * tenants' data.
 */
export async function findOwnedOrder(
  user: SessionUser,
  orderId: string,
): Promise<OrderHydrated> {
  return findOwnedOrderRaw(user.id, orderId);
}

export interface UpdateOrderInput {
  userId: string;
  orderId: string;
  customer?: string;
  dueDate?: Date;
  lineItems?: { description: string; quantity: number; unitPriceCents: number }[];
}

/**
 * Update an order's metadata and/or line items.
 *
 * ## Why this is one conditional update rather than read-check-save
 *
 * The obvious implementation loads the order, checks `payments.length === 0`,
 * mutates it, and calls `.save()`. A payment can be recorded by a different
 * request in the gap between that check and the save — `recordPayment` below
 * makes payment-vs-payment atomic, but it cannot make this route's stale
 * read atomic. The save would then overwrite the total out from under a
 * payment that was validated against the old one, leaving the order
 * internally over-paid (`amountPaidCents > totalCents`).
 *
 * Folding the "no payments yet" check into the `findOneAndUpdate` filter —
 * the same trick `recordPayment` uses for the balance guard — makes the check
 * and the write one atomic database operation, so there is no gap for a
 * concurrent payment to land in. Line totals are computed here, before the
 * write, because bypassing `.save()` also bypasses the model's pre-validate
 * hook that would otherwise do it.
 */
export async function updateOrder({
  userId,
  orderId,
  customer,
  dueDate,
  lineItems,
}: UpdateOrderInput): Promise<OrderHydrated> {
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    throw new ApiError("not_found", "Order not found.");
  }

  const setFields: Record<string, unknown> = {};
  if (customer !== undefined) setFields.customer = customer;
  if (dueDate !== undefined) setFields.dueDate = dueDate;

  const changesLineItems = lineItems !== undefined;
  if (lineItems) {
    const { lineTotalsCents, subtotalCents } = computeLineTotals(lineItems);
    setFields.lineItems = lineItems.map((item, index) => ({
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: lineTotalsCents[index],
    }));
    setFields.subtotalCents = subtotalCents;
    setFields.totalCents = subtotalCents;
  }

  const filter: QueryFilter<OrderDoc> = {
    _id: new mongoose.Types.ObjectId(orderId),
    userId: new mongoose.Types.ObjectId(userId),
  };
  // The lock: only matches if no payment has landed yet. Irrelevant — and
  // omitted — for metadata-only updates, which stay legal after payment.
  if (changesLineItems) filter["payments.0"] = { $exists: false };

  const order = await Order.findOneAndUpdate(filter, { $set: setFields }, {
    returnDocument: "after",
    runValidators: true,
  });
  if (order) return order;

  // Nothing matched. Read (tenant-scoped, so it can't confirm a stranger's
  // order exists) to tell "not found" apart from "locked by a payment".
  const existing = await findOwnedOrderRaw(userId, orderId);

  if (!changesLineItems) {
    // The filter was just _id + userId, and the read above just proved that
    // document exists and is ours — this should be unreachable.
    throw new ApiError("conflict", "The order could not be updated. Retry the request.");
  }

  throw new ApiError("order_locked", "Line items cannot be changed after a payment is recorded.", {
    hint: "Customer and due date are still editable. To change the amount, void this order and issue a new one.",
    meta: {
      paymentCount: existing.payments.length,
      amountPaidCents: existing.amountPaidCents,
      amountPaid: centsToDollarString(existing.amountPaidCents),
    },
  });
}

/**
 * Delete an order, atomically refusing to do so if a payment has landed.
 *
 * Same race as `updateOrder` above: a stale "does it have payments?" read
 * followed by a separate delete would let a payment recorded in between slip
 * an order with money against it past the check. `findOneAndDelete` folds the
 * check into the delete itself.
 */
export async function deleteOrder(userId: string, orderId: string): Promise<void> {
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    throw new ApiError("not_found", "Order not found.");
  }

  const deleted = await Order.findOneAndDelete({
    _id: new mongoose.Types.ObjectId(orderId),
    userId: new mongoose.Types.ObjectId(userId),
    "payments.0": { $exists: false },
  });
  if (deleted) return;

  const existing = await findOwnedOrderRaw(userId, orderId);

  throw new ApiError("order_locked", "Orders with recorded payments cannot be deleted.", {
    hint: "Refund the payments first, or keep the order for your records.",
    meta: {
      paymentCount: existing.payments.length,
      amountPaid: centsToDollarString(existing.amountPaidCents),
    },
  });
}

/**
 * Dashboard summary totals over every order matching `filter` — not just the
 * page a paginated list request happens to return.
 *
 * Status (and therefore `isOverdue`/`amountDueCents`) is derived, not stored,
 * so a database-side `$group` can't reproduce it without duplicating
 * `deriveOrderState`'s precedence rules in aggregation syntax — the same
 * reason `statusFilter` in orderQuery.ts exists as a parallel, tested
 * translation rather than logic embedded twice. Reusing the function itself
 * here, over a lean projection, keeps there being exactly one implementation
 * of "what counts as overdue." This scans every matching order rather than
 * aggregating in the database, which is fine at the scale a per-user order
 * list reaches; a real per-user running total (or a proper aggregation
 * pipeline mirroring the derivation) would be the fix if that stops being true.
 */
export async function computeOrderAggregates(
  filter: QueryFilter<OrderDoc>,
  now: Date = new Date(),
): Promise<OrderAggregates> {
  const rows = await Order.find(filter, { totalCents: 1, amountPaidCents: 1, dueDate: 1 }).lean();

  const totals: OrderAggregates = {
    billedCents: 0,
    collectedCents: 0,
    outstandingCents: 0,
    overdueCents: 0,
  };

  for (const row of rows) {
    const { amountDueCents, isOverdue } = deriveOrderState({
      amountPaidCents: row.amountPaidCents,
      totalCents: row.totalCents,
      dueDate: row.dueDate,
      now,
    });
    totals.billedCents += row.totalCents;
    totals.collectedCents += row.amountPaidCents;
    totals.outstandingCents += amountDueCents;
    if (isOverdue) totals.overdueCents += amountDueCents;
  }

  return totals;
}

/** Tenant-scoped lookup by raw id strings, for `findOwnedOrder` and the two mutators above. */
async function findOwnedOrderRaw(userId: string, orderId: string): Promise<OrderHydrated> {
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    throw new ApiError("not_found", "Order not found.");
  }

  const order = await Order.findOne({
    _id: new mongoose.Types.ObjectId(orderId),
    userId: new mongoose.Types.ObjectId(userId),
  });
  if (!order) throw new ApiError("not_found", "Order not found.");
  return order;
}
