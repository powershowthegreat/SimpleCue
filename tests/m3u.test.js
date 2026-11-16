import test from "node:test";
import assert from "node:assert/strict";
import { serialize, parse, validateSequence } from "../server/m3u.js";
const media = {
  one: { id: "one", filename: "first.wav", name: "First", duration: 20 },
  two: { id: "two", filename: "second.mp4", name: "Second", duration: 10 },
};
const seq = {
  id: "show",
  name: "Test show",
  description: "A/V test",
  cues: [
    {
      id: "c1",
      mediaId: "one",
      volume: 68,
      speed: 1.25,
      start: 2,
      end: 18,
      follow: false,
    },
    {
      id: "c2",
      mediaId: "two",
      volume: 90,
      speed: 0.5,
      start: 0,
      end: 8,
      follow: true,
    },
  ],
};
test("extended M3U preserves metadata, trims, speeds, volume and links", () => {
  const clean = { ...validateSequence(seq, media), id: seq.id };
  assert.deepEqual(parse(serialize(clean, media), media), clean);
});
test("plain extended playlists resolve uploaded filenames", () =>
  assert.equal(
    parse("#EXTM3U\n#PLAYLIST:Imported\n#EXTINF:20,First\nfirst.wav\n", media)
      .cues[0].mediaId,
    "one",
  ));
test("missing media is explicit", () =>
  assert.throws(
    () => parse("#EXTM3U\nmissing.mp3", media),
    /Upload the missing media/,
  ));
test("invalid trim, speed, volume, and duplicate IDs are rejected", () => {
  for (const bad of [
    { start: 19, end: 2 },
    { start: -1 },
    { end: 30 },
    { speed: -1 },
    { volume: 201 },
    { end: NaN },
  ]) {
    assert.throws(() =>
      validateSequence({ ...seq, cues: [{ ...seq.cues[0], ...bad }] }, media),
    );
  }
  assert.throws(
    () => validateSequence({ ...seq, cues: [seq.cues[0], seq.cues[0]] }, media),
    /Duplicate/,
  );
});

test("a follow link only survives when its specific source cue is immediately before it", () => {
  const linked = validateSequence(
    { ...seq, cues: [seq.cues[0], { ...seq.cues[1], followFrom: "c1" }] },
    media,
  );
  assert.equal(linked.cues[1].followFrom, "c1");
  const reordered = validateSequence(
    {
      ...seq,
      cues: [
        { ...seq.cues[0], id: "new" },
        { ...seq.cues[1], followFrom: "c1" },
      ],
    },
    media,
  );
  assert.equal(reordered.cues[1].follow, false);
  assert.equal(reordered.cues[1].followFrom, null);
});
test("zero speed is a valid paused cue", () =>
  assert.equal(
    validateSequence({ ...seq, cues: [{ ...seq.cues[0], speed: 0 }] }, media)
      .cues[0].speed,
    0,
  ));

test("gain up to 200 and counted/forever loops survive M3U round trips", () => {
  for (const loop of [1, 3, "forever"]) {
    const clean = {
      ...validateSequence(
        { ...seq, cues: [{ ...seq.cues[0], volume: 200, loop }] },
        media,
      ),
      id: "loop-test",
    };
    assert.equal(clean.cues[0].loop, loop);
    assert.equal(clean.cues[0].volume, 200);
    assert.deepEqual(parse(serialize(clean, media), media), clean);
  }
  for (const loop of [0, -1, 1.5, 10001, "bad", Infinity])
    assert.throws(
      () =>
        validateSequence({ ...seq, cues: [{ ...seq.cues[0], loop }] }, media),
      /Loop count/,
    );
});
