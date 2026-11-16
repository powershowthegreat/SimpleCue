import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
test("local store serializes concurrent writes and persists across instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "simplecue-store-"));
  try {
    const file = path.join(dir, "db.json"),
      s = new Store({ url: "", token: "", file });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.put("media", String(i), { id: i }),
      ),
    );
    assert.equal(Object.keys(await s.all("media")).length, 20);
    await s.put("media", "0", { id: "changed" }, true);
    assert.equal((await s.all("media"))["0"].id, 0);
    const second = new Store({ url: "", token: "", file });
    assert.deepEqual(await second.all("media"), await s.all("media"));
    await second.set("session", { user: "admin" }, 1);
    assert.deepEqual(await second.get("session"), { user: "admin" });
    await second.del("session");
    assert.equal(await second.get("session"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
