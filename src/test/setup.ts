import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * Shared in-memory MongoDB for the DB-backed suites.
 *
 * Real MongoDB, not a mock: the over-payment guard is a `$expr` condition
 * evaluated by the server, so mocking the driver would test nothing that
 * matters. This keeps the suite runnable with no local database installed.
 */

let server: MongoMemoryServer | null = null;

export async function startTestDatabase(): Promise<string> {
  server = await MongoMemoryServer.create();
  const uri = server.getUri();
  await mongoose.connect(uri, { dbName: "test" });

  // `connectToDatabase` (src/lib/db.ts) — what route handlers actually call —
  // reads `MONGODB_URI` and caches its own connection on `globalThis`,
  // separate from the default connection above. Point both at this same
  // in-memory server so route-handler tests (which go through
  // `connectToDatabase`) share it rather than dialing a second connection.
  // A no-op for tests that only touch models directly.
  process.env.MONGODB_URI = uri;
  (
    globalThis as {
      __mongooseCache?: { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null };
    }
  ).__mongooseCache = { conn: mongoose, promise: Promise.resolve(mongoose) };

  return uri;
}

export async function stopTestDatabase(): Promise<void> {
  await mongoose.disconnect();
  await server?.stop();
  server = null;
}

/** Wipe every collection between tests so cases cannot leak into each other. */
export async function clearTestDatabase(): Promise<void> {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}
