import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { store } from "../server/store.js";
import { migrateMediaRecord, writeSequenceBlob } from "../server/blob.js";
const all = Object.values(await store.all("media")).filter(
  (m) => !m.demo && m.storage !== "upstash",
);
let migrated = 0,
  failed = 0;
for (const m of all) {
  try {
    let body,
      source = m;
    if (m.storage === "disk") {
      const file = path.resolve(
          process.env.DATA_DIR || "data",
          "uploads",
          path.basename(m.storedFilename),
        ),
        details = await stat(file);
      source = { ...m, size: details.size };
      body = () => Readable.toWeb(createReadStream(file));
    } else {
      const response = await fetch(m.url);
      if (!response.ok) throw new Error("Could not read the original upload.");
      body = response.body;
      const size = Number(response.headers.get("content-length"));
      if (Number.isFinite(size) && size > 0) source = { ...m, size };
    }
    await migrateMediaRecord(source, body);
    migrated++;
    console.log(`Migrated ${m.id}`);
  } catch (e) {
    failed++;
    console.error(`Could not migrate ${m.id}: ${e.message}`);
  }
}
let sequences = 0;
for (const [id, text] of Object.entries(await store.all("sequences"))) {
  try {
    if (await writeSequenceBlob(id, text, { skipUnchanged: true })) sequences++;
  } catch (e) {
    failed++;
    console.error(`Could not migrate sequence ${id}: ${e.message}`);
  }
}
console.log(
  JSON.stringify({ migrated, sequences, failed, originalsPreserved: true }),
);
if (failed) process.exitCode = 1;
