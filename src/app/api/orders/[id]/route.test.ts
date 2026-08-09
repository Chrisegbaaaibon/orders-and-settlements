import { vi, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

vi.mock("next/headers", () => import("@/test/authMock").then((m) => m.cookiesModule));

import mongoose from "mongoose";
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from "@/test/setup";
import { resetAuthCookieMock, signInAs } from "@/test/authMock";
import { Order } from "@/models/Order";
import { GET, PATCH, DELETE } from "./route";

const USER = { id: new mongoose.Types.ObjectId().toString(), email: "owner@example.com" };
const OTHER_USER = { id: new mongoose.Types.ObjectId().toString(), email: "someone-else@example.com" };

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/orders/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedOrder(userId: string) {
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

describe("/api/orders/:id", () => {
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

  describe("GET", () => {
    it("requires authentication", async () => {
      const order = await seedOrder(USER.id);
      const response = await GET(new Request("http://localhost/api/orders/x"), context(order.id));
      expect(response.status).toBe(401);
    });

    it("returns full order detail including line items", async () => {
      const order = await seedOrder(USER.id);
      await signInAs(USER);

      const response = await GET(new Request("http://localhost/api/orders/x"), context(order.id));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.order.customer).toBe("Acme Corp");
      expect(body.order.lineItems).toHaveLength(1);
    });

    it("returns 404 for another user's order", async () => {
      const order = await seedOrder(OTHER_USER.id);
      await signInAs(USER);

      const response = await GET(new Request("http://localhost/api/orders/x"), context(order.id));
      expect(response.status).toBe(404);
    });

    it("returns 404 for a malformed id", async () => {
      await signInAs(USER);
      const response = await GET(new Request("http://localhost/api/orders/x"), context("not-an-id"));
      expect(response.status).toBe(404);
    });
  });

  describe("PATCH", () => {
    it("updates metadata", async () => {
      const order = await seedOrder(USER.id);
      await signInAs(USER);

      const response = await PATCH(patchRequest({ customer: "New Name" }), context(order.id));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.order.customer).toBe("New Name");
    });

    it("recomputes totals when line items change", async () => {
      const order = await seedOrder(USER.id);
      await signInAs(USER);

      const response = await PATCH(
        patchRequest({ lineItems: [{ description: "Redone", quantity: 3, unitPrice: "10.00" }] }),
        context(order.id),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.order.totalCents).toBe(3_000);
    });

    it("returns 409 order_locked when editing line items after a payment", async () => {
      const order = await seedOrder(USER.id);
      await Order.updateOne(
        { _id: order._id },
        { $push: { payments: { amountCents: 10_000, date: new Date(), createdAt: new Date() } } },
      );
      await signInAs(USER);

      const response = await PATCH(
        patchRequest({ lineItems: [{ description: "New", quantity: 1, unitPrice: "10.00" }] }),
        context(order.id),
      );
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe("order_locked");
    });

    it("returns 404 for another user's order", async () => {
      const order = await seedOrder(OTHER_USER.id);
      await signInAs(USER);

      const response = await PATCH(patchRequest({ customer: "Hijacked" }), context(order.id));
      expect(response.status).toBe(404);
    });
  });

  describe("DELETE", () => {
    it("deletes an order with no payments", async () => {
      const order = await seedOrder(USER.id);
      await signInAs(USER);

      const response = await DELETE(new Request("http://localhost/api/orders/x", { method: "DELETE" }), context(order.id));
      expect(response.status).toBe(200);
      expect(await Order.findById(order.id)).toBeNull();
    });

    it("returns 409 order_locked for an order with a payment", async () => {
      const order = await seedOrder(USER.id);
      await Order.updateOne(
        { _id: order._id },
        { $push: { payments: { amountCents: 10_000, date: new Date(), createdAt: new Date() } } },
      );
      await signInAs(USER);

      const response = await DELETE(new Request("http://localhost/api/orders/x", { method: "DELETE" }), context(order.id));
      expect(response.status).toBe(409);
      expect(await Order.findById(order.id)).not.toBeNull();
    });

    it("returns 404 for another user's order", async () => {
      const order = await seedOrder(OTHER_USER.id);
      await signInAs(USER);

      const response = await DELETE(new Request("http://localhost/api/orders/x", { method: "DELETE" }), context(order.id));
      expect(response.status).toBe(404);
    });
  });
});
