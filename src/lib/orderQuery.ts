import type { QueryFilter } from "mongoose";
import type { OrderDoc } from "@/models/Order";
import type { OrderStatus } from "./status";

/**
 * Translate a derived status into a MongoDB filter.
 *
 * Status is computed, not stored, so filtering by it means expressing the same
 * rules as `deriveOrderState` in query form. The two must stay in step —
 * `orderQuery.test.ts` cross-checks them against a fixture covering every
 * state, so changing one without the other fails the suite.
 */

/** Midnight UTC today. Due dates are stored at UTC midnight, so an order is
 *  past due exactly when its due date falls strictly before this. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const FULLY_PAID = { $expr: { $gte: ["$amountPaidCents", "$totalCents"] } };
const NOT_FULLY_PAID = { $expr: { $lt: ["$amountPaidCents", "$totalCents"] } };

export function statusFilter(status: OrderStatus, now = new Date()): QueryFilter<OrderDoc> {
  const today = startOfUtcDay(now);

  switch (status) {
    case "paid":
      return FULLY_PAID;

    case "overdue":
      // Paid outranks overdue, so a settled order never appears here.
      return { ...NOT_FULLY_PAID, dueDate: { $lt: today } };

    case "partially_paid":
      return { ...NOT_FULLY_PAID, amountPaidCents: { $gt: 0 }, dueDate: { $gte: today } };

    case "pending":
      return { ...NOT_FULLY_PAID, amountPaidCents: 0, dueDate: { $gte: today } };
  }
}
