import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { demoMedia } from "../server/seed.js";
execFileSync(
  process.execPath,
  [
    "node_modules/@tailwindcss/cli/dist/index.mjs",
    "-i",
    "src/styles.css",
    "-o",
    "public/styles.css",
    "--minify",
  ],
  { stdio: "inherit" },
);
await build({
  stdin: {
    contents: 'export {upload} from "@upstash/blob/browser";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "public/upstash-upload.js",
  platform: "browser",
});
await rm("public/blob-client.js", { force: true });
await mkdir("public/demo", { recursive: true });
// Original synthesized demo audio, generated deterministically. No external assets.
for (let j = 0; j < demoMedia.length; j++) {
  const m = demoMedia[j],
    rate = 22050,
    frames = m.duration * rate,
    b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(frames * 2, 40);
  let noise = 42;
  for (let i = 0; i < frames; i++) {
    const t = i / rate,
      fade = Math.min(t / 1.2, 1, (m.duration - t) / 1.5),
      root = [130.81, 261.63, 164.81, 110, 220, 196][j];
    noise = (noise * 16807) % 2147483647;
    const pad =
      Math.sin(2 * Math.PI * root * t) * 0.14 +
      Math.sin(2 * Math.PI * root * 1.5 * t) * 0.08 +
      Math.sin(2 * Math.PI * root * 2 * t) * 0.035;
    const pulse =
      j === 2 || j === 5
        ? Math.exp(-(t % 0.5) * 18) * Math.sin(2 * Math.PI * 65 * t) * 0.14
        : 0;
    const sweep =
      j === 4 ? Math.sin(2 * Math.PI * (100 * t + 80 * t * t)) * 0.13 : 0;
    b.writeInt16LE(
      Math.max(
        -32767,
        Math.min(
          32767,
          Math.round(
            (pad * (0.75 + 0.25 * Math.sin(t * 0.8)) +
              pulse +
              sweep +
              (noise / 2147483647 - 0.5) * 0.004) *
              fade *
              32767,
          ),
        ),
      ),
      44 + i * 2,
    );
  }
  await writeFile(`public/demo/${m.filename}`, b);
}
console.log("SimpleCue built: Tailwind, Blob client, and original demo audio.");
