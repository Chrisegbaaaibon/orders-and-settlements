import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end coverage: the assignment's sample scenario driven through a real
 * browser against a real (in-memory) MongoDB, plus a mobile-viewport pass —
 * the two things the vitest suite structurally cannot exercise (real cookies,
 * real navigation, real rendered layout at a given width).
 *
 * A fixed port and a fixed Mongo port (distinct from `npm run dev:db`'s
 * 27018) keep this from colliding with a developer's own `npm run dev`.
 */

const PORT = 3100;
export const MONGO_PORT = 27019;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // Specs share one seeded database and drive one persistent page per file
  // (test.describe.serial) — parallel workers would race each other on it.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    // `next dev` refuses to run a second instance for the same project
    // directory (a directory-level lock, not a port lock), which collides
    // with any dev server already running locally. `next build && next
    // start` doesn't hit that lock and is closer to the deployed app anyway.
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      MONGODB_URI: `mongodb://127.0.0.1:${MONGO_PORT}`,
      MONGODB_DB: "e2e",
      AUTH_SECRET: "e2e-throwaway-32-plus-character-secret-value-x",
    },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // A 390px viewport — the same width the audit's manual mobile check
    // used — on Chromium rather than the `devices["iPhone 13"]` preset,
    // which pulls in WebKit. WebKit does not extend Chromium's "loopback is
    // a secure context" allowance to Secure cookies, so the session cookie
    // `next start` sets (Secure in production, see src/lib/auth.ts) is
    // silently dropped over this suite's plain-http 127.0.0.1 webServer —
    // a WebKit/HTTP testing-environment quirk, not a real app bug, and not
    // worth weakening the app's actual Secure-cookie behavior to work around.
    // Running the same specs under this project is the "mobile smoke
    // coverage" this suite is required to have, without a separate,
    // drifting copy of the flow.
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
