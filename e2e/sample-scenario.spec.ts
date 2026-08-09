import { test, expect, type Page } from "@playwright/test";

/**
 * The assignment's sample scenario, end to end through a real browser:
 * sign up, create the $500 x 2 order due in 7 days, partially pay it,
 * attempt to over-pay by a cent (rejected with a one-click correction),
 * then settle it in full.
 *
 * Runs under both the "chromium" and "mobile" Playwright projects (see
 * playwright.config.ts) — the mobile pass is this suite's mobile smoke
 * coverage, exercising the exact same flow at a ~390px viewport rather than
 * a separate, drifting "does it look ok" check.
 */
test.describe.configure({ mode: "serial" });

const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
const password = "e2e-test-password-123";

let page: Page;
let orderUrl: string;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page?.close();
});

test("sign up", async () => {
  await page.goto("/signup");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test("create the sample order: 2 x $500, due in 7 days", async () => {
  await page.goto("/orders/new");
  await page.locator("#customer").fill("Acme Corp");
  // #dueDate is pre-filled 7 days out by the form itself — the sample scenario's date.
  await page.locator("#desc-0").fill("Consulting");
  await page.locator("#qty-0").fill("2");
  await page.locator("#price-0").fill("500.00");
  await page.getByRole("button", { name: "Create order" }).click();

  await expect(page).toHaveURL(/\/orders\/[a-f0-9]{24}/);
  orderUrl = page.url();
  await expect(page.getByText("$1,000.00").first()).toBeVisible();
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();
});

test("shows the new order on the dashboard", async () => {
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Acme Corp" })).toBeVisible();
  await expect(page.getByText("1 order", { exact: true })).toBeVisible();
});

test("records a $400 partial payment", async () => {
  await page.goto(orderUrl);
  await page.locator("#amount").fill("400.00");
  await page.getByRole("button", { name: "Record payment" }).click();

  await expect(page.getByText("Partially paid", { exact: true })).toBeVisible();
  await expect(page.getByText("$600.00").first()).toBeVisible(); // amount due
});

test("rejects a $600.01 over-payment and offers a one-click correction", async () => {
  await page.locator("#amount").fill("600.01");
  await page.getByRole("button", { name: "Record payment" }).click();

  await expect(page.getByText(/exceeds/i)).toBeVisible();
  const correction = page.getByRole("button", { name: "Use $600.00 instead" });
  await expect(correction).toBeVisible();
  await correction.click();
  await expect(page.locator("#amount")).toHaveValue("600.00");
});

test("completes the payment and reaches paid status", async () => {
  await page.getByRole("button", { name: "Record payment" }).click();

  await expect(page.getByText("Paid", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settled" })).toBeVisible();
  // The form is gone once settled — nothing left to overpay against.
  await expect(page.locator("#amount")).toHaveCount(0);
});

test("the paid order's delete button is gone, but it still exists", async () => {
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Acme Corp")).toBeVisible();
});

test("dashboard layout does not overflow horizontally", async () => {
  await page.goto("/dashboard");
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1); // +1: sub-pixel rounding
});
