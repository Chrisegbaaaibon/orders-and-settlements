import { vi, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

vi.mock("next/headers", () => import("@/test/authMock").then((m) => m.cookiesModule));

import mongoose from "mongoose";
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from "@/test/setup";
import { resetAuthCookieMock, signInAs } from "@/test/authMock";
import { Order } from "@/models/Order";
import { POST } from "./route";

const USER = { id: new mongoose.Types.ObjectId().toString(), email: "owner@example.com" };

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function paymentRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/orders/x/payments", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function seedOrder() {
  return Order.create({
    userId: new mongoose.Types.ObjectId(USER.id),
    customer: "Acme Corp",
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    lineItems: [{ description: "Consulting", quantity: 2, unitPriceCents: 50_000, lineTotalCents: 100_000 }],
    payments: [],
    amountPaidCents: 0,
    subtotalCents: 0,
    totalCents: 0,
  });
}

describe("POST /api/orders/:id/payments", () => {
  beforeAll(async () => {
    await startTestDatabase();
    process.env.AUTH_SECRET ??= "a-throwaway-32-plus-character-test-secret";
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
    resetAuthCookieMock();
  });

  it("requires authentication", async () => {
    const order = await seedOrder();
    const response = await POST(paymentRequest({ amount: "100.00" }), context(order.id));
    expect(response.status).toBe(401);
  });

  it("records a payment and returns the updated order", async () => {
    const order = await seedOrder();
    await signInAs(USER);

    const response = await POST(paymentRequest({ amount: "400.00" }), context(order.id));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.order.amountPaidCents).toBe(40_000);
    expect(body.payment.amount).toBe("400.00");
  });

  it("rejects an over-payment with 422 and an actionable meta.maxAllowed", async () => {
    const order = await seedOrder();
    await signInAs(USER);

    const response = await POST(paymentRequest({ amount: "1000.01" }), context(order.id));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("over_payment");
    expect(body.error.meta.maxAllowedCents).toBe(100_000);
  });

  it("replays the same payment for a repeated Idempotency-Key instead of double-charging", async () => {
    const order = await seedOrder();
    await signInAs(USER);

    const first = await POST(
      paymentRequest({ amount: "400.00" }, { "Idempotency-Key": "retry-1" }),
      context(order.id),
    ).then((r) => r.json());
    const second = await POST(
      paymentRequest({ amount: "400.00" }, { "Idempotency-Key": "retry-1" }),
      context(order.id),
    ).then((r) => r.json());

    expect(second.payment.id).toBe(first.payment.id);
    const reloaded = await Order.findById(order.id);
    expect(reloaded?.payments).toHaveLength(1);
    expect(reloaded?.amountPaidCents).toBe(40_000);
  });

  it("treats a different Idempotency-Key as a separate payment", async () => {
    const order = await seedOrder();
    await signInAs(USER);

    await POST(paymentRequest({ amount: "400.00" }, { "Idempotency-Key": "a" }), context(order.id));
    await POST(paymentRequest({ amount: "400.00" }, { "Idempotency-Key": "b" }), context(order.id));

    const reloaded = await Order.findById(order.id);
    expect(reloaded?.payments).toHaveLength(2);
    expect(reloaded?.amountPaidCents).toBe(80_000);
  });

  it("rejects an Idempotency-Key over 200 characters with a clean validation error", async () => {
    const order = await seedOrder();
    await signInAs(USER);

    const response = await POST(
      paymentRequest({ amount: "100.00" }, { "Idempotency-Key": "x".repeat(201) }),
      context(order.id),
    );
    expect(response.status).toBe(400);
    expect(await Order.findById(order.id).then((o) => o?.payments.length)).toBe(0);
  });

  it("returns 404 for another user's order", async () => {
    const otherOrder = await Order.create({
      userId: new mongoose.Types.ObjectId(),
      customer: "Not mine",
      dueDate: new Date(),
      lineItems: [{ description: "X", quantity: 1, unitPriceCents: 1_000, lineTotalCents: 1_000 }],
      payments: [],
      amountPaidCents: 0,
      subtotalCents: 0,
      totalCents: 0,
    });
    await signInAs(USER);

    const response = await POST(paymentRequest({ amount: "10.00" }), context(otherOrder.id));
    expect(response.status).toBe(404);
  });
});
