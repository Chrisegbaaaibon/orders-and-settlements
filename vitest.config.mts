import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolves the `@/*` alias from tsconfig.json natively.
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Spinning up an in-memory MongoDB takes a few seconds on a cold run, and
    // the concurrency tests deliberately wait on parallel writes.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Each DB-backed file starts its own in-memory server; running them in
    // parallel processes multiplies memory use for no wall-clock gain here.
    fileParallelism: false,
  },
});
