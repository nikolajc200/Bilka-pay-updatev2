import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresPlanStore } from "../plan-store.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = join(root, "data");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exitCode = 1;
} else {
  const ssl = process.env.DATABASE_SSL === "false"
    ? false
    : process.env.DATABASE_SSL === "true" || process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined;
  const store = new PostgresPlanStore({
    connectionString: process.env.DATABASE_URL,
    ssl
  });

  try {
    await store.initialize();
    const files = await readdir(dataDir, { withFileTypes: true });
    let migrated = 0;
    let skipped = 0;

    for (const file of files) {
      if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      try {
        const payload = JSON.parse(await readFile(join(dataDir, file.name), "utf8"));
        if (!payload.state?.updatedAt) throw new Error("Missing updatedAt");
        await store.save(file.name.slice(0, -5), payload.state);
        migrated += 1;
      } catch (error) {
        skipped += 1;
        console.warn(`Skipped ${file.name}: ${error.message}`);
      }
    }

    console.log(`Migrated ${migrated} plan(s); skipped ${skipped}.`);
  } finally {
    await store.close();
  }
}
