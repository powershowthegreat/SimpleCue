import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
test("Express API: auth, uploads, M3U persistence and media integrity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "simplecue-api-")),
    probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      UPSTASH_BLOB_TOKEN: "",
      VERCEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  const call = (url, opts = {}) =>
    fetch(base + url, {
      ...opts,
      headers: { cookie, "Content-Type": "application/json", ...opts.headers },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(base + "/api/health");
        if (r.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
      if (i === 99) throw new Error(logs);
    }
    assert.equal((await call("/api/workspace")).status, 401);
    assert.equal(
      (
        await call("/api/login", {
          method: "POST",
          body: { username: "admin", password: "wrong" },
        })
      ).status,
      401,
    );
    const login = await call("/api/login", {
      method: "POST",
      body: { username: "admin", password: "admin" },
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(login.headers.get("set-cookie"), /HttpOnly/);
    const ws = await (await call("/api/workspace")).json();
    assert.equal(ws.media.length, 6);
    assert.equal(ws.sequences.length, 3);
    const fd = new FormData();
    const sample = await readFile("public/demo/opening-sting.wav");
    fd.append("file", new Blob([sample], { type: "audio/wav" }), "test.wav");
    fd.append("folder", "Test folder");
    const upload = await fetch(base + "/api/media", {
      method: "POST",
      headers: { cookie },
      body: fd,
    });
    assert.equal(upload.status, 201, await upload.clone().text());
    const m = await upload.json();
    assert.equal(m.duration, 8);
    assert.equal(m.folder, "Test folder");
    const ranged = await fetch(base + m.url, {
      headers: { cookie, range: "bytes=0-43" },
    });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 44);
    const flac = await readFile("tests/fixtures/upload-test.flac");
    const start = await (
      await call("/api/uploads", {
        method: "POST",
        body: {
          filename: "audio.flac",
          name: "FLAC test",
          folder: "Uploads",
          size: flac.length,
          type: "audio/flac",
          duration: 1,
        },
      })
    ).json();
    const chunk = await fetch(
      base + `/api/uploads/${start.id}/chunks?offset=0`,
      {
        method: "POST",
        headers: { cookie, "Content-Type": "application/octet-stream" },
        body: flac,
      },
    );
    assert.equal(chunk.status, 200);
    assert.equal((await chunk.json()).received, flac.length);
    const duplicate = await fetch(
      base + `/api/uploads/${start.id}/chunks?offset=0`,
      {
        method: "POST",
        headers: { cookie, "Content-Type": "application/octet-stream" },
        body: flac,
      },
    );
    assert.equal(duplicate.status, 200);
    const completed = await call(`/api/uploads/${start.id}/complete`, {
      method: "POST",
    });
    assert.equal(completed.status, 201, await completed.clone().text());
    const flacMedia = await completed.json();
    assert.equal(flacMedia.extension, "FLAC");
    assert.equal(flacMedia.duration, 1);
    await call("/api/media/" + flacMedia.id, { method: "DELETE" });
    let s = await (
      await call("/api/sequences", {
        method: "POST",
        body: {
          name: "API test",
          description: "Round trip",
          cues: [
            {
              id: "testcue",
              mediaId: m.id,
              start: 1,
              end: 5,
              volume: 70,
              speed: 1.5,
              follow: true,
            },
          ],
        },
      })
    ).json();
    assert.equal(s.cues[0].volume, 70);
    const disk = await readFile(
      path.join(dir, "sequences", s.id + ".m3u"),
      "utf8",
    );
    assert.match(disk, /#CUE:/);
    assert.equal(
      (await call("/api/media/" + m.id, { method: "DELETE" })).status,
      409,
    );
    const invalid = await call("/api/sequences/" + s.id, {
      method: "PUT",
      body: { ...s, cues: [{ ...s.cues[0], end: 100 }] },
    });
    assert.equal(invalid.status, 400);
    const text = await (
      await call("/api/sequences/" + s.id + "/download")
    ).text();
    assert.match(text, /#EXTM3U/);
    const renamedResponse = await call("/api/media/" + m.id, {
      method: "PATCH",
      body: { filename: "Renamed audio.wav" },
    });
    assert.equal(renamedResponse.status, 200);
    const renamed = await renamedResponse.json();
    assert.equal(renamed.id, m.id);
    assert.equal(renamed.url, m.url);
    assert.equal(renamed.storedFilename, m.storedFilename);
    assert.equal(renamed.folder, m.folder);
    assert.equal(renamed.filename, "Renamed audio.wav");
    const renamedWs = await (await call("/api/workspace")).json();
    const renamedSequence = renamedWs.sequences.find((seq) => seq.id === s.id);
    assert.deepEqual(renamedSequence.cues[0], {
      ...s.cues[0],
      name: "Renamed audio",
    });
    const renamedM3u = await (
      await call("/api/sequences/" + s.id + "/download")
    ).text();
    assert.match(renamedM3u, /\nRenamed audio\.wav\n/);
    const renamedAudio = await fetch(base + renamed.url, {
      headers: { cookie },
    });
    assert.deepEqual(Buffer.from(await renamedAudio.arrayBuffer()), sample);
    assert.equal(
      (
        await call("/api/media/" + m.id, {
          method: "PATCH",
          body: { filename: "wrong.mp3" },
        })
      ).status,
      400,
    );
    // The playlist exported before the rename must remain importable too.
    const imp = new FormData();
    imp.append("file", new Blob([text]), "test.m3u");
    const imported = await fetch(base + "/api/sequences/import", {
      method: "POST",
      headers: { cookie },
      body: imp,
    });
    assert.equal(imported.status, 201);
    const copy = await imported.json();
    assert.equal(copy.cues[0].speed, 1.5);
    assert.equal(
      (
        await call("/api/preferences", {
          method: "PUT",
          body: {
            activeId: s.id,
            accent: "#bccfe4",
            keybinds: { toggle: " " },
          },
        })
      ).status,
      200,
    );
    for (const id of [s.id, copy.id])
      assert.equal(
        (await call("/api/sequences/" + id, { method: "DELETE" })).status,
        200,
      );
    assert.equal(
      (await call("/api/media/" + m.id, { method: "DELETE" })).status,
      200,
    );
    await call("/api/logout", { method: "POST" });
    assert.equal((await call("/api/workspace")).status, 401);
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
    await rm(dir, { recursive: true, force: true });
  }
});
