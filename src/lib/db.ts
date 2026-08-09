import mongoose from "mongoose";

/**
 * Serverless-safe Mongoose connection.
 *
 * On Vercel each lambda invocation may reuse a warm container, so we cache the
 * connection promise on `globalThis` to avoid opening a new pool per request
 * (which exhausts Atlas connection limits fast). Caching the *promise* rather
 * than the connection also means concurrent cold-start requests share one dial.
 */

declare global {
  var __mongooseCache:
    | { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null }
    | undefined;
}

const cache = globalThis.__mongooseCache ?? { conn: null, promise: null };
globalThis.__mongooseCache = cache;

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Copy .env.example to .env.local and point it at your MongoDB instance.",
    );
  }

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(uri, {
        dbName: process.env.MONGODB_DB || undefined,
        // Fail fast instead of hanging a request for 30s when the cluster is unreachable.
        serverSelectionTimeoutMS: 10_000,
        maxPoolSize: 10,
      })
      .catch((error) => {
        // Clear the cached rejection so the next request retries rather than
        // replaying the same failure forever.
        cache.promise = null;
        throw error;
      });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}
