import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { MONGO_PORT } from "../playwright.config";

/**
 * Dashboard pagination and CSV export, driven through the browser.
 *
 * Pagination is seeded directly against Mongo (fast, and not what's under
 * test) rather than by creating 30 orders through the UI one at a time.
 * Playwright specs run in Node, so a direct mongoose connection is just
 * another test tool here, the same way the vitest suites use one.
 */
test.describe.configure({ mode: "serial" });

const email = `e2e-dash-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
const password = "e2e-test-password-123";

let page: Page;
let userId: string;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();

  await page.goto("/signup");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  // An in-page fetch, not page.request.get: the httpOnly session cookie is
  // only guaranteed to ride along on a request the browser itself makes.
  const me = await page.evaluate(() => fetch("/api/auth/me").then((r) => r.json()));
  userId = me.user.id;

  // 30 orders of $100 each: two pages at the default page size of 25.
  // Inserted with the raw driver, matching the shape src/models/Order.ts's
  // schema stores, rather than importing that model — Playwright's TS
  // transform doesn't resolve this project's `@/*` tsconfig path alias the
  // way vitest's config does, and the model file imports through it.
  const connection = await mongoose
    .createConnection(`mongodb://127.0.0.1:${MONGO_PORT}`, { dbName: "e2e" })
    .asPromise();
  await connection.collection("orders").insertMany(
    Array.from({ length: 30 }, (_, i) => ({
      userId: new mongoose.Types.ObjectId(userId),
      customer: `Bulk Customer ${i}`,
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      lineItems: [
        { description: "Item", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 },
      ],
      payments: [],
      amountPaidCents: 0,
      subtotalCents: 10_000,
      totalCents: 10_000,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  await connection.close();
});

test.afterAll(async () => {
  await page?.close();
});

test("dashboard paginates and totals the complete filtered set, not just the page", async () => {
  await page.goto("/dashboard");

  await expect(page.getByText("30 orders", { exact: true })).toBeVisible();
  // Billed total is over all 30 orders ($3,000), even though only 25 rows render.
  await expect(page.getByText("$3,000.00").first()).toBeVisible();
  await expect(page.getByText("Page 1 of 2")).toBeVisible();

  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(25);

  const nextButton = page.getByRole("button", { name: "Next" });
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
  await nextButton.click();

  await expect(page.getByText("Page 2 of 2")).toBeVisible();
  await expect(rows).toHaveCount(5);
  await expect(nextButton).toBeDisabled();

  // The total is unchanged on page 2 — it always describes the whole filtered set.
  await expect(page.getByText("$3,000.00").first()).toBeVisible();
});

test("changing the filter resets back to page 1", async () => {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Page 2 of 2")).toBeVisible();

  await page.getByRole("tab", { name: "Pending" }).click();
  await expect(page.getByText("Page 1 of 2")).toBeVisible();
});

test("CSV export downloads a file with the expected columns", async () => {
  await page.goto("/dashboard");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Export CSV" }).click(),
  ]);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf-8");

  expect(text.split("\n")[0]).toBe(
    "order_id,customer,due_date,status,is_overdue,order_total,amount_paid,amount_due,payment_count,created_at",
  );
  // Header + 30 data rows (+ trailing newline splits to one empty entry).
  expect(text.trim().split("\n")).toHaveLength(31);
});
