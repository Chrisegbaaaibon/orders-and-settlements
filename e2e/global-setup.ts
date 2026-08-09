import { MongoMemoryServer } from "mongodb-memory-server";
import { MONGO_PORT } from "../playwright.config";

/**
 * Starts the in-memory MongoDB the Next dev server (spawned by
 * `webServer` in playwright.config.ts) connects to. Runs once for the whole
 * suite, in the test-runner process — separate from the Next server process,
 * which only sees the connection string via `MONGODB_URI`.
 *
 * The returned function is Playwright's documented way to register a
 * teardown without a separate `globalTeardown` file.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = await MongoMemoryServer.create({ instance: { port: MONGO_PORT } });

  return async () => {
    await server.stop();
  };
}
