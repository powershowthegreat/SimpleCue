import test from "node:test";
import assert from "node:assert/strict";
import { renameMediaFile } from "../public/media-name.js";
import { parse } from "../server/m3u.js";
const original = {
  id: "same-id",
  filename: "old.wav",
  name: "Old",
  extension: "WAV",
  duration: 2,
};
test("renames preserve file type and old M3U aliases without changing media IDs", () => {
  const change = renameMediaFile(original, "New name.wav");
  assert.equal(change.name, "New name");
  assert.equal(change.filename, "New name.wav");
  assert.deepEqual(change.aliases, ["old.wav"]);
  const renamed = { ...original, ...change };
  assert.equal(
    parse("#EXTM3U\nold.wav\n", { "same-id": renamed }).cues[0].mediaId,
    "same-id",
  );
  assert.equal(renameMediaFile(original, "New name").filename, "New name.wav");
  for (const invalid of ["", "../bad.wav", "change.mp3", "bad/path.wav"])
    assert.throws(() => renameMediaFile(original, invalid));
});
