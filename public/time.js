// Display time to hundredths while storing cue settings as source-file seconds.
export function formatTime(value) {
  if (value === Infinity) return "∞";
  const hundredths = Math.round(Math.max(0, Number(value) || 0) * 100);
  const minutes = Math.floor(hundredths / 6000);
  const seconds = Math.floor((hundredths % 6000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths % 100).padStart(2, "0")}`;
}
export function formatCropTime(value) {
  return formatTime(value).replace(".", ":");
}
export function parseCropTime(value) {
  const match = /^(\d+):([0-5]\d)[:.](\d{2})$/.exec(String(value).trim());
  if (!match)
    throw new Error("Use MM:SS:cc for crop times, for example 01:23:45.");
  const hundredths =
    Number(match[1]) * 6000 + Number(match[2]) * 100 + Number(match[3]);
  if (!Number.isSafeInteger(hundredths))
    throw new Error("Crop time is too large.");
  return hundredths / 100;
}
