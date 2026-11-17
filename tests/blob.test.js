import test from "node:test";
import assert from "node:assert/strict";
import {
  uploadMetadata,
  recordFromBlob,
  registerBlobMedia,
  MEDIA_PREFIX,
} from "../server/blob.js";
const id = "12345678-1234-1234-1234-123456789abc",
  p = {
    id,
    name: "Audio",
    filename: "audio.flac",
    folder: "Show",
    duration: 12.34,
    extension: "FLAC",
  };
const metadata = {
  owner: Buffer.from("admin").toString("base64url"),
  simplecue: Buffer.from(JSON.stringify(p)).toString("base64url"),
};
const blob = {
  path: `${MEDIA_PREFIX}${id}.flac`,
  size: 1000,
  contentType: "audio/flac",
  etag: '"test"',
  uploadedAt: new Date("2026-01-01"),
};
test("Upstash media records use stable authenticated URLs, verified size, and exact object paths", () => {
  const m = recordFromBlob(blob, metadata, "admin");
  assert.equal(m.url, `/api/media/${id}/file`);
  assert.equal(m.storage, "upstash");
  assert.equal(m.blobPath, blob.path);
  assert.equal(m.size, 1000);
  assert.equal(m.duration, 12.34);
  assert.equal(m.url.includes("token"), false);
  assert.throws(() => recordFromBlob(blob, metadata, "other"));
  assert.throws(() =>
    recordFromBlob({ ...blob, path: "other/file.flac" }, metadata, "admin"),
  );
  assert.throws(() =>
    recordFromBlob(blob, { ...metadata, simplecue: "bad" }, "admin"),
  );
});
test("upload metadata rejects missing duration and completion retries preserve edited records", async () => {
  for (const duration of [0, -1, "bad", Infinity])
    assert.throws(() => uploadMetadata({ duration }));
  const records = {},
    target = {
      all: async () => records,
      put: async (_, key, value) => (records[key] = value),
    };
  const first = await registerBlobMedia(blob, metadata, "admin", target);
  first.name = "Renamed";
  assert.equal(
    (await registerBlobMedia(blob, metadata, "admin", target)).name,
    "Renamed",
  );
  assert.equal(Object.keys(records).length, 1);
});
