/**
 * Throwaway local MongoDB for development.
 *
 * Downloads and runs a real mongod on a fixed port with no Docker and no
 * system install, so `npm run dev:db` is all a reviewer needs to try the app.
 * Data lives in .mongo-data/ and survives restarts.
 *
 * For anything real, point MONGODB_URI at Atlas instead.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import { mkdirSync } from "node:fs";

const PORT = 27018;
const DB_PATH = ".mongo-data";

mkdirSync(DB_PATH, { recursive: true });

const server = await MongoMemoryServer.create({
  instance: { port: PORT, dbPath: DB_PATH, storageEngine: "wiredTiger" },
});

console.log(`\n  MongoDB running at ${server.getUri()}`);
console.log(`  Data directory: ${DB_PATH}/`);
console.log(`\n  Leave this running and start the app in another terminal:\n`);
console.log(`    npm run dev\n`);

const shutdown = async () => {
  console.log("\n  Stopping MongoDB…");
  await server.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
