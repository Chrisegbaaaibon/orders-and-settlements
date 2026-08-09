import { vi, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

vi.mock("next/headers", () => import("@/test/authMock").then((m) => m.cookiesModule));

import mongoose from "mongoose";
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from "@/test/setup";
import { resetAuthCookieMock, signInAs } from "@/test/authMock";
import { Order } from "@/models/Order";
import { GET, POST } from "./route";

const USER = { id: new mongoose.Types.ObjectId().toString(), email: "owner@example.com" };
const OTHER_USER = { id: new mongoose.Types.ObjectId().toString(), email: "someone-else@example.com" };

function ordersRequest(query = ""): Request {
  return new Request(`http://localhost/api/orders${query}`);
}

function createOrderRequest(body: unknown): Request {
  return new Request("http://localhost/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Seed an order directly against the model — HTTP is what's under test, not order creation. */
async function seedOrder(overrides: {
  userId: string;
  customer?: string;
  dueDate?: Date;
  quantity?: number;
  unitPriceCents?: number;
}) {
  const { userId, customer = "Acme Corp", dueDate = new Date(), quantity = 1, unitPriceCents = 10_000 } = overrides;
  return Order.create({
    userId: new mongoose.Types.ObjectId(userId),
    customer,
    dueDate,
    lineItems: [{ description: "Item", quantity, unitPriceCents, lineTotalCents: quantity * unitPriceCents }],
    payments: [],
    amountPaidCents: 0,
    subtotalCents: 0,
    totalCents: 0,
  });
}

describe("/api/orders", () => {
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
      const response = await GET(ordersRequest());
      expect(response.status).toBe(401);
    });

    it("returns an empty list for a user with no orders", async () => {
      await signInAs(USER);
      const response = await GET(ordersRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.orders).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it("only returns the signed-in user's orders", async () => {
      await seedOrder({ userId: USER.id, customer: "Mine" });
      await seedOrder({ userId: OTHER_USER.id, customer: "Not mine" });
      await signInAs(USER);

      const response = await GET(ordersRequest());
      const body = await response.json();
      expect(body.orders).toHaveLength(1);
      expect(body.orders[0].customer).toBe("Mine");
    });

    it("filters by search term", async () => {
      await seedOrder({ userId: USER.id, customer: "Acme Corp" });
      await seedOrder({ userId: USER.id, customer: "Widgets Inc" });
      await signInAs(USER);

      const response = await GET(ordersRequest("?search=acme"));
      const body = await response.json();
      expect(body.orders).toHaveLength(1);
      expect(body.orders[0].customer).toBe("Acme Corp");
    });

    it("paginates results and reports correct pagination metadata", async () => {
      for (let i = 0; i < 5; i++) {
        await seedOrder({ userId: USER.id, customer: `Customer ${i}` });
      }
      await signInAs(USER);

      const firstPage = await GET(ordersRequest("?pageSize=2&page=1")).then((r) => r.json());
      expect(firstPage.orders).toHaveLength(2);
      expect(firstPage.pagination).toEqual({ page: 1, pageSize: 2, total: 5, totalPages: 3 });

      const lastPage = await GET(ordersRequest("?pageSize=2&page=3")).then((r) => r.json());
      expect(lastPage.orders).toHaveLength(1); // 5 orders, page 3 of size 2 has the remainder
    });

    it("computes aggregates over the whole filtered set, not just the current page", async () => {
      // 3 orders of $100 each, only the first page (size 2) is returned.
      for (let i = 0; i < 3; i++) {
        await seedOrder({ userId: USER.id, quantity: 1, unitPriceCents: 10_000 });
      }
      await signInAs(USER);

      const body = await GET(ordersRequest("?pageSize=2&page=1")).then((r) => r.json());
      expect(body.orders).toHaveLength(2);
      // Aggregate is over all 3 orders ($300), not just the 2 on this page ($200).
      expect(body.aggregates.billedCents).toBe(30_000);
      expect(body.aggregates.billed).toBe("300.00");
    });

    it("aggregates reflect the active status filter", async () => {
      const paid = await seedOrder({ userId: USER.id, unitPriceCents: 10_000 });
      await Order.updateOne({ _id: paid._id }, { $set: { amountPaidCents: 10_000 } });
      await seedOrder({ userId: USER.id, unitPriceCents: 5_000 }); // stays pending
      await signInAs(USER);

      const body = await GET(ordersRequest("?status=paid")).then((r) => r.json());
      expect(body.orders).toHaveLength(1);
      expect(body.aggregates.billedCents).toBe(10_000);
      expect(body.aggregates.collectedCents).toBe(10_000);
    });
  });

  describe("POST", () => {
    it("requires authentication", async () => {
      const response = await POST(
        createOrderRequest({
          customer: "Acme",
          dueDate: "2026-06-01",
          lineItems: [{ description: "Widget", quantity: 2, unitPrice: "10.00" }],
        }),
      );
      expect(response.status).toBe(401);
    });

    it("creates an order with server-computed totals", async () => {
      await signInAs(USER);
      const response = await POST(
        createOrderRequest({
          customer: "Acme",
          dueDate: "2026-06-01",
          lineItems: [
            { description: "Widget", quantity: 2, unitPrice: "10.00" },
            { description: "Gadget", quantity: 1, unitPrice: "5.50" },
          ],
        }),
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.order.totalCents).toBe(2_550); // 2 * 1000 + 550
      expect(body.order.total).toBe("25.50");
    });

    it("rejects a request missing required fields with 400", async () => {
      await signInAs(USER);
      const response = await POST(createOrderRequest({ customer: "Acme" }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("validation_error");
    });

    it("rejects a quantity/unit-price combination that overflows a safe integer", async () => {
      await signInAs(USER);
      const response = await POST(
        createOrderRequest({
          customer: "Acme",
          dueDate: "2026-06-01",
          lineItems: [
            { description: "Too big", quantity: 1_000_000, unitPrice: "1000000000.00" },
          ],
        }),
      );
      expect(response.status).toBe(400);

      // And nothing was written.
      const count = await Order.countDocuments({ userId: new mongoose.Types.ObjectId(USER.id) });
      expect(count).toBe(0);
    });

    it("rejects an invalid calendar date", async () => {
      await signInAs(USER);
      const response = await POST(
        createOrderRequest({
          customer: "Acme",
          dueDate: "2026-02-30",
          lineItems: [{ description: "Widget", quantity: 1, unitPrice: "10.00" }],
        }),
      );
      expect(response.status).toBe(400);
    });
  });
});
