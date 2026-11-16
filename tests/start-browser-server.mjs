import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const dir = await mkdtemp(path.join(os.tmpdir(), "simplecue-browser-"));
Object.assign(process.env, {
  DATA_DIR: dir,
  UPSTASH_REDIS_REST_URL: "",
  UPSTASH_REDIS_REST_TOKEN: "",
  BLOB_READ_WRITE_TOKEN: "",
  VERCEL: "",
});
const { default: app } = await import("../app.js");
const server = app.listen(3210, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(async () => {
      await rm(dir, { recursive: true, force: true });
      process.exit(0);
    }),
  );
