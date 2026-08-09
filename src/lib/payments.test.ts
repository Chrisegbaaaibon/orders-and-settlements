import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from "@/test/setup";
import { Order, type OrderHydrated } from "@/models/Order";
import { recordPayment, type RecordPaymentResult } from "./payments";
import { ApiError } from "./errors";
import { deriveOrderState } from "./status";

/**
 * Integration tests against a real (in-memory) MongoDB.
 *
 * The over-payment rule is enforced by a `$expr` condition the *database*
 * evaluates, so these tests exercise the real query engine rather than a mock.
 */

const USER_ID = new mongoose.Types.ObjectId().toString();
const OTHER_USER_ID = new mongoose.Types.ObjectId().toString();

/** Derive an order's state at a given instant. Reads fields explicitly rather
 *  than spreading — a Mongoose document keeps its data behind getters, so
 *  `{...doc}` would not carry the schema fields. */
function stateAt(
  order: Pick<OrderHydrated, "amountPaidCents" | "totalCents" | "dueDate">,
  now?: Date,
) {
  return deriveOrderState({
    amountPaidCents: order.amountPaidCents,
    totalCents: order.totalCents,
    dueDate: order.dueDate,
    now,
  });
}

beforeAll(async () => {
  await startTestDatabase();
});

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearTestDatabase();
});

/** The brief's sample order: 2 x $500, due in 7 days. */
async function createSampleOrder(
  overrides: { userId?: string; dueDate?: Date; quantity?: number; unitPriceCents?: number } = {},
): Promise<OrderHydrated> {
  const {
    userId = USER_ID,
    dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    quantity = 2,
    unitPriceCents = 50_000,
  } = overrides;

  return Order.create({
    userId: new mongoose.Types.ObjectId(userId),
    customer: "Acme Corp",
    dueDate,
    lineItems: [
      {
        description: "Consulting",
        quantity,
        unitPriceCents,
        lineTotalCents: quantity * unitPriceCents,
      },
    ],
    payments: [],
    amountPaidCents: 0,
    subtotalCents: 0,
    totalCents: 0,
  });
}

describe("order totals", () => {
  it("computes subtotal and total from the line items", async () => {
    const order = await createSampleOrder();
    expect(order.subtotalCents).toBe(100_000);
    expect(order.totalCents).toBe(100_000);
  });

  it("sums multiple line items", async () => {
    const order = await Order.create({
      userId: new mongoose.Types.ObjectId(USER_ID),
      customer: "Multi",
      dueDate: new Date(),
      lineItems: [
        { description: "A", quantity: 3, unitPriceCents: 1_999, lineTotalCents: 0 },
        { description: "B", quantity: 1, unitPriceCents: 25_000, lineTotalCents: 0 },
      ],
      payments: [],
      amountPaidCents: 0,
      subtotalCents: 0,
      totalCents: 0,
    });

    // 3 x $19.99 = $59.97, plus $250.00 = $309.97
    expect(order.totalCents).toBe(30_997);
  });

  it("ignores a client-supplied total", async () => {
    const order = await Order.create({
      userId: new mongoose.Types.ObjectId(USER_ID),
      customer: "Tamper",
      dueDate: new Date(),
      lineItems: [{ description: "A", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 0 }],
      payments: [],
      amountPaidCents: 0,
      subtotalCents: 1,
      totalCents: 1, // pretend a client tried to set the total to a penny
    });

    expect(order.totalCents).toBe(10_000);
  });
});

describe("the brief's sample scenario", () => {
  it("walks pending -> partially_paid -> paid and rejects the extra dollar", async () => {
    const created = await createSampleOrder();
    expect(created.totalCents).toBe(100_000);
    expect(stateAt(created).status).toBe("pending");

    // 2. $400 -> partially_paid, $600 due
    const first = await recordPayment({
      userId: USER_ID,
      orderId: created.id,
      amountCents: 40_000,
    });
    expect(first.order.amountPaidCents).toBe(40_000);
    const afterFirst = stateAt(first.order);
    expect(afterFirst.status).toBe("partially_paid");
    expect(afterFirst.amountDueCents).toBe(60_000);

    // 3. $600 -> paid, $0 due
    const second = await recordPayment({
      userId: USER_ID,
      orderId: created.id,
      amountCents: 60_000,
    });
    expect(second.order.amountPaidCents).toBe(100_000);
    const afterSecond = stateAt(second.order);
    expect(afterSecond.status).toBe("paid");
    expect(afterSecond.amountDueCents).toBe(0);

    // 4. A further $1 is rejected with an actionable error.
    const rejection = await recordPayment({
      userId: USER_ID,
      orderId: created.id,
      amountCents: 100,
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ApiError);
    const error = rejection as ApiError;
    expect(error.code).toBe("over_payment");
    expect(error.status).toBe(422);
    expect(error.message).toContain("already paid in full");
    expect(error.meta?.maxAllowedCents).toBe(0);

    // And nothing was written.
    const reloaded = await Order.findById(created.id);
    expect(reloaded?.amountPaidCents).toBe(100_000);
    expect(reloaded?.payments).toHaveLength(2);
  });
});

describe("over-payment rejection", () => {
  it("rejects a single payment larger than the total", async () => {
    const order = await createSampleOrder();

    const error = (await recordPayment({
      userId: USER_ID,
      orderId: order.id,
      amountCents: 100_001,
    }).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("over_payment");
    expect(error.meta?.maxAllowedCents).toBe(100_000);
    expect(error.meta?.maxAllowed).toBe("1000.00");
    expect(error.hint).toContain("$1,000.00 or less");

    const reloaded = await Order.findById(order.id);
    expect(reloaded?.payments).toHaveLength(0);
    expect(reloaded?.amountPaidCents).toBe(0);
  });

  it("rejects a payment that would exceed the remaining balance", async () => {
    const order = await createSampleOrder();
    await recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 90_000 });

    const error = (await recordPayment({
      userId: USER_ID,
      orderId: order.id,
      amountCents: 10_001,
    }).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("over_payment");
    expect(error.meta?.maxAllowedCents).toBe(10_000);
    expect(error.meta?.amountPaidCents).toBe(90_000);
  });

  it("accepts a payment for exactly the remaining balance", async () => {
    const order = await createSampleOrder();
    await recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 90_000 });

    const { order: settled } = await recordPayment({
      userId: USER_ID,
      orderId: order.id,
      amountCents: 10_000,
    });

    expect(settled.amountPaidCents).toBe(100_000);
    expect(stateAt(settled).status).toBe("paid");
  });

  it("accepts many small payments that sum to the total", async () => {
    const order = await createSampleOrder();

    for (let i = 0; i < 10; i++) {
      await recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 10_000 });
    }

    const reloaded = await Order.findById(order.id);
    expect(reloaded?.payments).toHaveLength(10);
    expect(reloaded?.amountPaidCents).toBe(100_000);
    expect(stateAt(reloaded!).status).toBe("paid");
  });
});

describe("idempotency", () => {
  it("returns the original payment when the same key is retried sequentially", async () => {
    const order = await createSampleOrder(); // $1,000

    const first = await recordPayment({
      userId: USER_ID,
      orderId: order.id,
      amountCents: 40_000,
      idempotencyKey: "retry-key-1",
    });
    const second = await recordPayment({
      userId: USER_ID,
      orderId: order.id,
      amountCents: 40_000,
      idempotencyKey: "retry-key-1",
    });

    expect(second.payment.id).toBe(first.payment.id);

    const reloaded = await Order.findById(order.id);
    expect(reloaded?.payments).toHaveLength(1);
    expect(reloaded?.amountPaidCents).toBe(40_000); // not 80,000
  });

  it("treats a different key as a genuinely separate payment", async () => {
    const order = await createSampleOrder();

    await recordPayment({
      userId: USER_ID,
      orderId: order.id,
      amountCents: 40_000,
      idempotencyKey: "key-a",
    });
    await recordPayment({
      userId: USER_ID,
      orderId: order.id,
      amountCents: 40_000,
      idempotencyKey: "key-b",
    });

    const reloaded = await Order.findById(order.id);
    expect(reloaded?.payments).toHaveLength(2);
    expect(reloaded?.amountPaidCents).toBe(80_000);
  });

  it("omitting the key keeps the old behaviour: each call is its own payment", async () => {
    const order = await createSampleOrder();

    await recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 40_000 });
    await recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 40_000 });

    const reloaded = await Order.findById(order.id);
    expect(reloaded?.payments).toHaveLength(2);
    expect(reloaded?.amountPaidCents).toBe(80_000);
  });

  it("never double-charges when two copies of the same retry race each other", async () => {
    const order = await createSampleOrder(); // $1,000

    const results = await Promise.allSettled([
      recordPayment({
        userId: USER_ID,
        orderId: order.id,
        amountCents: 90_000,
        idempotencyKey: "concurrent-retry",
      }),
      recordPayment({
        userId: USER_ID,
        orderId: order.id,
        amountCents: 90_000,
        idempotencyKey: "concurrent-retry",
      }),
    ]);

    // Both calls succeed — from the client's point of view, its retry worked
    // — but they describe the same single payment, not two.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const [first, second] = results as PromiseFulfilledResult<RecordPaymentResult>[];
    expect(first.value.payment.id).toBe(second.value.payment.id);

    const reloaded = await Order.findById(order.id);
    expect(reloaded?.payments).toHaveLength(1);
    expect(reloaded?.amountPaidCents).toBe(90_000);
  });
});

describe("concurrency", () => {
  /**
   * The race the atomic guard exists to prevent. Two $600 payments are fired at
   * a $1,000 order with no await between them. A read-check-write
   * implementation lets both through and leaves the order paid $1,200; the
   * conditional update must let exactly one win.
   */
  it("lets only one of two conflicting simultaneous payments through", async () => {
    const order = await createSampleOrder();

    const results = await Promise.allSettled([
      recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 60_000 }),
      recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 60_000 }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
    expect(((rejected[0] as PromiseRejectedResult).reason as ApiError).code).toBe("over_payment");

    const reloaded = await Order.findById(order.id);
    expect(reloaded?.amountPaidCents).toBe(60_000);
    expect(reloaded?.payments).toHaveLength(1);
  });

  it("applies all of many simultaneous payments that do fit", async () => {
    const order = await createSampleOrder();

    // Ten parallel $100 payments against a $1,000 order: every one fits, so
    // none may be lost to a clobbered write either.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 10_000 }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);

    const reloaded = await Order.findById(order.id);
    expect(reloaded?.amountPaidCents).toBe(100_000);
    expect(reloaded?.payments).toHaveLength(10);
    expect(stateAt(reloaded!).status).toBe("paid");
  });

  it("never lets the paid total exceed the order total under contention", async () => {
    const order = await createSampleOrder();

    // Twenty parallel $100 payments against a $1,000 order: at most ten can win.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 10_000 }),
      ),
    );

    const accepted = results.filter((r) => r.status === "fulfilled").length;
    expect(accepted).toBe(10);

    const reloaded = await Order.findById(order.id);
    expect(reloaded?.amountPaidCents).toBe(100_000);
    expect(reloaded!.amountPaidCents).toBeLessThanOrEqual(reloaded!.totalCents);
  });
});

describe("ownership", () => {
  it("will not record a payment against another user's order", async () => {
    const order = await createSampleOrder({ userId: OTHER_USER_ID });

    const error = (await recordPayment({
      userId: USER_ID,
      orderId: order.id,
      amountCents: 10_000,
    }).catch((e: unknown) => e)) as ApiError;

    // 404, not 403 — a 403 would confirm the order exists.
    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);

    const reloaded = await Order.findById(order.id);
    expect(reloaded?.amountPaidCents).toBe(0);
  });

  it("returns not_found for an unknown order id", async () => {
    const error = (await recordPayment({
      userId: USER_ID,
      orderId: new mongoose.Types.ObjectId().toString(),
      amountCents: 10_000,
    }).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("not_found");
  });

  it("returns not_found for a malformed order id", async () => {
    const error = (await recordPayment({
      userId: USER_ID,
      orderId: "not-an-object-id",
      amountCents: 10_000,
    }).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("not_found");
  });
});

describe("status transitions over time", () => {
  it("moves an unpaid order to overdue once the due date passes", async () => {
    const order = await createSampleOrder({
      dueDate: new Date("2026-01-10T00:00:00.000Z"),
    });

    expect(stateAt(order, new Date("2026-01-05T12:00:00Z")).status).toBe(
      "pending",
    );
    expect(stateAt(order, new Date("2026-01-20T12:00:00Z")).status).toBe(
      "overdue",
    );
  });

  it("moves an overdue order to paid once settled, and it stays paid", async () => {
    const order = await createSampleOrder({
      dueDate: new Date("2026-01-10T00:00:00.000Z"),
    });
    const late = new Date("2026-02-01T12:00:00Z");

    expect(stateAt(order, late).status).toBe("overdue");

    const { order: settled } = await recordPayment({
      userId: USER_ID,
      orderId: order.id,
      amountCents: 100_000,
    });

    expect(stateAt(settled, late).status).toBe("paid");
    // Still paid a year later — settlement is permanent.
    expect(stateAt(settled, new Date("2027-01-01T00:00:00Z")).status).toBe(
      "paid",
    );
  });
});
