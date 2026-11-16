import test from "node:test";
import assert from "node:assert/strict";
import { formatTime, formatCropTime, parseCropTime } from "../public/time.js";
test("crop times use minutes, seconds and hundredths and preserve absolute source positions", () => {
  for (const [seconds, text] of [
    [0, "00:00:00"],
    [1, "00:01:00"],
    [2.34, "00:02:34"],
    [59.99, "00:59:99"],
    [60, "01:00:00"],
    [83.45, "01:23:45"],
    [3600.01, "60:00:01"],
  ]) {
    assert.equal(formatCropTime(seconds), text);
    assert.equal(parseCropTime(text), seconds);
  }
  assert.equal(formatTime(59.999), "01:00.00");
  assert.equal(parseCropTime("01:23.45"), 83.45);
});
test("invalid crop times cannot silently become seconds or roll over seconds", () => {
  for (const text of [
    "",
    "2.34",
    "01:60:00",
    "00:01:100",
    "-01:00:00",
    "00:01",
    "00:01:aa",
    "999999999999999999999:00:00",
  ])
    assert.throws(() => parseCropTime(text));
});
