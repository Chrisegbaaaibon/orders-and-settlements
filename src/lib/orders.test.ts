import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from "@/test/setup";
import { Order, type OrderHydrated } from "@/models/Order";
import { deleteOrder, updateOrder } from "./orders";
import { recordPayment } from "./payments";
import { ApiError } from "./errors";

/**
 * Integration tests against a real (in-memory) MongoDB — same rationale as
 * payments.test.ts: the locks here are `$expr`/filter conditions the database
 * evaluates, so a mocked driver would not exercise the thing that matters.
 */

const USER_ID = new mongoose.Types.ObjectId().toString();
const OTHER_USER_ID = new mongoose.Types.ObjectId().toString();

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
  overrides: { userId?: string } = {},
): Promise<OrderHydrated> {
  const { userId = USER_ID } = overrides;
  return Order.create({
    userId: new mongoose.Types.ObjectId(userId),
    customer: "Acme Corp",
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    lineItems: [{ description: "Consulting", quantity: 2, unitPriceCents: 50_000, lineTotalCents: 100_000 }],
    payments: [],
    amountPaidCents: 0,
    subtotalCents: 0,
    totalCents: 0,
  });
}

describe("updateOrder", () => {
  it("updates metadata", async () => {
    const order = await createSampleOrder();
    const updated = await updateOrder({
      userId: USER_ID,
      orderId: order.id,
      customer: "New Name",
    });
    expect(updated.customer).toBe("New Name");
    expect(updated.totalCents).toBe(100_000); // unchanged
  });

  it("recomputes totals when line items change", async () => {
    const order = await createSampleOrder();
    const updated = await updateOrder({
      userId: USER_ID,
      orderId: order.id,
      lineItems: [
        { description: "A", quantity: 3, unitPriceCents: 1_999 },
        { description: "B", quantity: 1, unitPriceCents: 25_000 },
      ],
    });
    expect(updated.subtotalCents).toBe(30_997);
    expect(updated.totalCents).toBe(30_997);
    expect(updated.lineItems).toHaveLength(2);
  });

  it("allows metadata edits after a payment has been recorded", async () => {
    const order = await createSampleOrder();
    await recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 40_000 });

    const updated = await updateOrder({ userId: USER_ID, orderId: order.id, customer: "Renamed" });
    expect(updated.customer).toBe("Renamed");
  });

  it("rejects a line-item edit once a payment has been recorded", async () => {
    const order = await createSampleOrder();
    await recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 40_000 });

    const error = (await updateOrder({
      userId: USER_ID,
      orderId: order.id,
      lineItems: [{ description: "A", quantity: 1, unitPriceCents: 10_000 }],
    }).catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("order_locked");
    expect(error.meta?.paymentCount).toBe(1);

    // Nothing was written.
    const reloaded = await Order.findById(order.id);
    expect(reloaded?.totalCents).toBe(100_000);
  });

  it("will not update another user's order", async () => {
    const order = await createSampleOrder({ userId: OTHER_USER_ID });
    const error = (await updateOrder({
      userId: USER_ID,
      orderId: order.id,
      customer: "Hijacked",
    }).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("not_found");
  });

  it("returns not_found for an unknown order id", async () => {
    const error = (await updateOrder({
      userId: USER_ID,
      orderId: new mongoose.Types.ObjectId().toString(),
      customer: "Nobody",
    }).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe("not_found");
  });
});

describe("deleteOrder", () => {
  it("deletes an order with no payments", async () => {
    const order = await createSampleOrder();
    await deleteOrder(USER_ID, order.id);
    expect(await Order.findById(order.id)).toBeNull();
  });

  it("rejects deleting an order once a payment has been recorded", async () => {
    const order = await createSampleOrder();
    await recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 40_000 });

    const error = (await deleteOrder(USER_ID, order.id).catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("order_locked");

    // The order and its payment both survive.
    const reloaded = await Order.findById(order.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.payments).toHaveLength(1);
  });

  it("will not delete another user's order", async () => {
    const order = await createSampleOrder({ userId: OTHER_USER_ID });
    const error = (await deleteOrder(USER_ID, order.id).catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("not_found");
    expect(await Order.findById(order.id)).not.toBeNull();
  });
});

describe("payment vs. line-item edit race", () => {
  /**
   * The exact scenario the audit reproduced: load a $1,000 order, record an
   * $800 payment, then save a stale PATCH with a new $500 total — landing at
   * amountPaidCents = 80,000 / totalCents = 50,000, an order paid more than
   * its own total. Firing both mutations with no await between them exercises
   * whichever database-level ordering actually happens, same as the
   * payment-vs-payment tests in payments.test.ts.
   */
  it("never leaves the order over-paid when a payment and a line-item edit race", async () => {
    const order = await createSampleOrder(); // $1,000 total, unpaid

    const [paymentResult, updateResult] = await Promise.allSettled([
      recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 80_000 }),
      updateOrder({
        userId: USER_ID,
        orderId: order.id,
        lineItems: [{ description: "Consulting", quantity: 1, unitPriceCents: 50_000 }],
      }),
    ]);

    const reloaded = await Order.findById(order.id);
    expect(reloaded).not.toBeNull();
    // The invariant the whole feature exists to protect.
    expect(reloaded!.amountPaidCents).toBeLessThanOrEqual(reloaded!.totalCents);

    if (updateResult.status === "fulfilled") {
      // The edit landed while the order still had no payments: the total
      // moved to $500, so the $800 payment against the old $1,000 total is
      // correctly rejected as an over-payment of the new total.
      expect(reloaded!.totalCents).toBe(50_000);
      expect(paymentResult.status).toBe("rejected");
      expect((paymentResult as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
      expect(((paymentResult as PromiseRejectedResult).reason as ApiError).code).toBe("over_payment");
    } else {
      // The payment landed first: the edit is now locked out, exactly as it
      // would be for a non-concurrent request made after the payment.
      expect(reloaded!.amountPaidCents).toBe(80_000);
      expect(reloaded!.totalCents).toBe(100_000);
      expect((updateResult as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
      expect(((updateResult as PromiseRejectedResult).reason as ApiError).code).toBe("order_locked");
    }
  });
});

describe("payment vs. delete race", () => {
  /** The delete-side variant of the same audit finding. */
  it("never deletes an order that a concurrent payment settles, and never loses a payment to a concurrent delete", async () => {
    const order = await createSampleOrder();

    const [paymentResult, deleteResult] = await Promise.allSettled([
      recordPayment({ userId: USER_ID, orderId: order.id, amountCents: 80_000 }),
      deleteOrder(USER_ID, order.id),
    ]);

    const reloaded = await Order.findById(order.id);

    if (deleteResult.status === "fulfilled") {
      // Delete landed while there were no payments yet: the order is gone,
      // and the payment attempted against it correctly finds nothing there.
      expect(reloaded).toBeNull();
      expect(paymentResult.status).toBe("rejected");
      expect(((paymentResult as PromiseRejectedResult).reason as ApiError).code).toBe("not_found");
    } else {
      // The payment landed first: the delete is now locked out, and the
      // order survives with its payment intact — never silently destroyed.
      expect(reloaded).not.toBeNull();
      expect(reloaded!.amountPaidCents).toBe(80_000);
      expect(reloaded!.payments).toHaveLength(1);
      expect((deleteResult as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
      expect(((deleteResult as PromiseRejectedResult).reason as ApiError).code).toBe("order_locked");
    }
  });
});
