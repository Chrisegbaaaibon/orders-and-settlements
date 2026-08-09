import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from "@/test/setup";
import { Order } from "@/models/Order";
import { ORDER_STATUSES, deriveOrderState } from "./status";
import { statusFilter } from "./orderQuery";

/**
 * `deriveOrderState` (used on read) and `statusFilter` (used to query) encode
 * the same rules in two different languages, so they can drift apart silently —
 * the dashboard would show an order as `overdue` while the Overdue tab omitted
 * it.
 *
 * This suite builds a fixture covering every state and asserts the two agree on
 * every one of them. Change one without the other and this fails.
 */

const USER_ID = new mongoose.Types.ObjectId();
const NOW = new Date("2026-03-15T12:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeAll(async () => {
  await startTestDatabase();
});

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearTestDatabase();
});

async function seedOrder(label: string, totalCents: number, paidCents: number, dueDate: string) {
  const order = await Order.create({
    userId: USER_ID,
    customer: label,
    dueDate: day(dueDate),
    lineItems: [
      { description: label, quantity: 1, unitPriceCents: totalCents, lineTotalCents: totalCents },
    ],
    payments: [],
    amountPaidCents: 0,
    subtotalCents: 0,
    totalCents: 0,
  });

  if (paidCents > 0) {
    // Written directly rather than through recordPayment — this suite is about
    // the query, and some fixtures deliberately sit at unusual balances.
    await Order.updateOne(
      { _id: order._id },
      {
        $set: { amountPaidCents: paidCents },
        $push: { payments: { amountCents: paidCents, date: day(dueDate), createdAt: NOW } },
      },
    );
  }

  return order;
}

/** One order in each meaningful state, relative to NOW = 2026-03-15. */
async function seedAllStates() {
  await Promise.all([
    seedOrder("pending-future", 100_000, 0, "2026-03-22"),
    seedOrder("pending-due-today", 100_000, 0, "2026-03-15"),
    seedOrder("partial-future", 100_000, 40_000, "2026-03-22"),
    seedOrder("partial-due-today", 100_000, 40_000, "2026-03-15"),
    seedOrder("paid-future", 100_000, 100_000, "2026-03-22"),
    seedOrder("paid-late", 100_000, 100_000, "2026-01-01"),
    seedOrder("overdue-unpaid", 100_000, 0, "2026-03-14"),
    seedOrder("overdue-partial", 100_000, 40_000, "2026-01-01"),
    seedOrder("zero-total", 0, 0, "2026-01-01"),
  ]);
}

describe("statusFilter", () => {
  it("agrees with deriveOrderState for every status", async () => {
    await seedAllStates();

    const all = await Order.find({ userId: USER_ID });

    for (const status of ORDER_STATUSES) {
      const expected = all
        .filter(
          (order) =>
            deriveOrderState({
              amountPaidCents: order.amountPaidCents,
              totalCents: order.totalCents,
              dueDate: order.dueDate,
              now: NOW,
            }).status === status,
        )
        .map((order) => order.customer)
        .sort();

      const actual = (await Order.find({ userId: USER_ID, ...statusFilter(status, NOW) }))
        .map((order) => order.customer)
        .sort();

      expect(actual, `mismatch for status "${status}"`).toEqual(expected);
    }
  });

  it("partitions the orders — every order matches exactly one status", async () => {
    await seedAllStates();

    const counts = await Promise.all(
      ORDER_STATUSES.map((status) =>
        Order.countDocuments({ userId: USER_ID, ...statusFilter(status, NOW) }),
      ),
    );

    const total = await Order.countDocuments({ userId: USER_ID });
    expect(counts.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it("places specific fixtures in the tab a user would expect", async () => {
    await seedAllStates();

    const namesFor = async (status: (typeof ORDER_STATUSES)[number]) =>
      (await Order.find({ userId: USER_ID, ...statusFilter(status, NOW) }))
        .map((order) => order.customer)
        .sort();

    expect(await namesFor("pending")).toEqual(["pending-due-today", "pending-future"]);
    expect(await namesFor("partially_paid")).toEqual(["partial-due-today", "partial-future"]);
    // A late-but-settled order lives under Paid, not Overdue.
    expect(await namesFor("paid")).toEqual(["paid-future", "paid-late", "zero-total"]);
    expect(await namesFor("overdue")).toEqual(["overdue-partial", "overdue-unpaid"]);
  });
});
