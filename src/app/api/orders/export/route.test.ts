import { vi, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

vi.mock("next/headers", () => import("@/test/authMock").then((m) => m.cookiesModule));

import mongoose from "mongoose";
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from "@/test/setup";
import { resetAuthCookieMock, signInAs } from "@/test/authMock";
import { Order } from "@/models/Order";
import { GET } from "./route";

const USER = { id: new mongoose.Types.ObjectId().toString(), email: "owner@example.com" };
const OTHER_USER = { id: new mongoose.Types.ObjectId().toString(), email: "someone-else@example.com" };

function exportRequest(query = ""): Request {
  return new Request(`http://localhost/api/orders/export${query}`);
}

async function seedOrder(overrides: { userId?: string; customer?: string; dueDate?: Date } = {}) {
  const { userId = USER.id, customer = "Acme Corp", dueDate = new Date("2026-06-01T00:00:00.000Z") } = overrides;
  return Order.create({
    userId: new mongoose.Types.ObjectId(userId),
    customer,
    dueDate,
    lineItems: [{ description: "Consulting", quantity: 2, unitPriceCents: 50_000, lineTotalCents: 100_000 }],
    payments: [],
    amountPaidCents: 0,
    subtotalCents: 0,
    totalCents: 0,
  });
}

describe("GET /api/orders/export", () => {
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
    const response = await GET(exportRequest());
    expect(response.status).toBe(401);
  });

  it("streams a CSV with a header row and one row per order", async () => {
    await seedOrder({ customer: "Acme Corp" });
    await signInAs(USER);

    const response = await GET(exportRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");

    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe(
      "order_id,customer,due_date,status,is_overdue,order_total,amount_paid,amount_due,payment_count,created_at",
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Acme Corp");
    expect(lines[1]).toContain("1000.00"); // order_total
  });

  it("only exports the signed-in user's orders", async () => {
    await seedOrder({ userId: USER.id, customer: "Mine" });
    await seedOrder({ userId: OTHER_USER.id, customer: "Not mine" });
    await signInAs(USER);

    const text = await GET(exportRequest()).then((r) => r.text());
    expect(text).toContain("Mine");
    expect(text).not.toContain("Not mine");
  });

  it("filters by due-date range, inclusive of both ends", async () => {
    await seedOrder({ customer: "Too early", dueDate: new Date("2026-01-01T00:00:00.000Z") });
    await seedOrder({ customer: "In range start", dueDate: new Date("2026-06-01T00:00:00.000Z") });
    await seedOrder({ customer: "In range end", dueDate: new Date("2026-06-30T00:00:00.000Z") });
    await seedOrder({ customer: "Too late", dueDate: new Date("2026-12-01T00:00:00.000Z") });
    await signInAs(USER);

    const text = await GET(exportRequest("?from=2026-06-01&to=2026-06-30")).then((r) => r.text());
    expect(text).toContain("In range start");
    expect(text).toContain("In range end");
    expect(text).not.toContain("Too early");
    expect(text).not.toContain("Too late");
  });

  it("guards a customer name that looks like a spreadsheet formula", async () => {
    await seedOrder({ customer: "=cmd|'/c calc'!A1" });
    await signInAs(USER);

    const text = await GET(exportRequest()).then((r) => r.text());
    // Quoted (because of the internal comma/quote) with a leading apostrophe
    // before the formula character, so a spreadsheet renders it as text.
    expect(text).toContain("'=cmd");
  });

  it("rejects a malformed date range with 400", async () => {
    await signInAs(USER);
    const response = await GET(exportRequest("?from=not-a-date"));
    expect(response.status).toBe(400);
  });
});
