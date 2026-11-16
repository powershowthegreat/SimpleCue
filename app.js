import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import {
  readFile,
  writeFile,
  mkdir,
  unlink,
  stat,
  appendFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { parseBuffer, parseFile } from "music-metadata";
import { handleUpload } from "@vercel/blob/client";
import { head, del } from "@vercel/blob";
import { store } from "./server/store.js";
import { serialize, parse, validateSequence } from "./server/m3u.js";
import { demoMedia, demoSequences } from "./server/seed.js";

const app = express(),
  cloud = Boolean(process.env.VERCEL),
  root = process.cwd(),
  dataDir = path.resolve(process.env.DATA_DIR || "data");
const users = JSON.parse(
  await readFile(new URL("./config/users.json", import.meta.url), "utf8"),
);
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});
const extensions = new Set([
  "wav",
  "mp3",
  "ogg",
  "m4a",
  "aac",
  "flac",
  "aif",
  "aiff",
  "mp4",
  "webm",
  "mov",
]);
const safe = (v) =>
  String(v || "")
    .replace(/[^a-zA-Z0-9 ._\-]/g, "")
    .trim()
    .slice(0, 150);
const fail = (status, message) => Object.assign(new Error(message), { status });
let initialized;
async function init() {
  if (!initialized)
    initialized = (async () => {
      if (cloud && !store.url)
        throw fail(
          503,
          "Set the Upstash Redis environment variables before using SimpleCue on Vercel.",
        );
      if (!(await store.get("initialized"))) {
        for (const m of demoMedia) await store.put("media", m.id, m, true);
        const media = Object.fromEntries(demoMedia.map((m) => [m.id, m]));
        for (const s of demoSequences)
          await store.put("sequences", s.id, serialize(s, media), true);
        await store.set("initialized", true);
      }
    })().catch((e) => {
      initialized = null;
      throw e;
    });
  return initialized;
}
app.get("/api/health", async (req, res) => {
  await init();
  res.json({
    ok: true,
    database: store.url ? "redis" : "local",
    uploads: process.env.BLOB_READ_WRITE_TOKEN
      ? "blob"
      : cloud
        ? "unconfigured"
        : "disk",
  });
});
app.post("/api/login", async (req, res) => {
  const user = users.find(
    (u) => u.username === req.body.username && u.password === req.body.password,
  );
  if (!user) throw fail(401, "That username and password do not match.");
  await init();
  const token = randomBytes(32).toString("hex");
  await store.set(
    `session:${token}`,
    { username: user.username, name: user.name },
    60 * 60 * 24 * 7,
  );
  res
    .cookie("simplecue_session", token, {
      httpOnly: true,
      secure: cloud || req.secure,
      sameSite: "lax",
      maxAge: 7 * 86400000,
      path: "/",
    })
    .json({ username: user.username, name: user.name });
});
async function auth(req, res, next) {
  const token = req.cookies.simplecue_session;
  const user = token && (await store.get(`session:${token}`));
  if (!user)
    return res.status(401).json({ error: "Sign in to open your workspace." });
  req.user = user;
  next();
}
// Blob callbacks carry a provider signature, validated by handleUpload. Token minting requires a session.
app.post("/api/blob/upload", async (req, res) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN)
    throw fail(
      503,
      "Connect a public Vercel Blob store and set BLOB_READ_WRITE_TOKEN to upload media in the cloud.",
    );
  const result = await handleUpload({
    body: req.body,
    request: req,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      const token = req.cookies.simplecue_session;
      if (!token || !(await store.get(`session:${token}`)))
        throw fail(401, "Sign in before uploading.");
      const p = JSON.parse(clientPayload || "{}"),
        ext = pathname.split(".").pop().toLowerCase();
      if (!extensions.has(ext) || !/^media\/[\w-]+\.[\w]+$/.test(pathname))
        throw fail(400, "Unsupported media file.");
      const duration = Number(p.duration);
      if (!Number.isFinite(duration) || duration <= 0)
        throw fail(400, "Could not read the media duration.");
      return {
        allowedContentTypes: ["audio/*", "video/*", "application/octet-stream"],
        maximumSizeInBytes: 500 * 1024 * 1024,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({
          name: safe(p.name),
          folder: safe(p.folder) || "Uploads",
          duration,
          filename: safe(p.filename),
          id: pathname.split("/")[1].split(".")[0],
          extension: ext.toUpperCase(),
        }),
      };
    },
    onUploadCompleted: async ({ blob, tokenPayload }) => {
      await registerBlob(
        { ...blob, ...(await head(blob.url)) },
        JSON.parse(tokenPayload),
      );
    },
  });
  res.json(result);
});
async function registerBlob(blob, p) {
  const m = {
    ...p,
    type: blob.contentType,
    size: blob.size || 0,
    url: blob.url,
    createdAt: new Date().toISOString(),
    storage: "blob",
  };
  await store.put("media", m.id, m);
  return m;
}
app.use("/api", auth);
app.get("/api/session", (req, res) => res.json(req.user));
app.post("/api/logout", async (req, res) => {
  await store.del(`session:${req.cookies.simplecue_session}`);
  res.clearCookie("simplecue_session", { path: "/" }).json({ ok: true });
});
app.get("/api/workspace", async (req, res) => {
  await init();
  const media = await store.all("media"),
    raw = await store.all("sequences");
  res.json({
    media: Object.values(media),
    sequences: Object.values(raw).map((s) => parse(s, media)),
    preferences: await store.get(`preferences:${req.user.username}`),
    database: store.url ? "redis" : "local",
    uploads: process.env.BLOB_READ_WRITE_TOKEN
      ? "blob"
      : cloud
        ? "unconfigured"
        : "disk",
  });
});
app.put("/api/preferences", async (req, res) => {
  const { activeId, accent, keybinds, panelLayout, mode } = req.body;
  const prefs = { activeId, accent, keybinds, panelLayout, mode };
  await store.set(`preferences:${req.user.username}`, prefs);
  res.json(prefs);
});
async function saveSequence(input, id) {
  const media = await store.all("media"),
    seq = {
      ...validateSequence(input, media),
      id,
      updatedAt: new Date().toISOString(),
    };
  const text = serialize(seq, media);
  await store.put("sequences", id, text);
  if (!cloud) {
    await mkdir(path.join(dataDir, "sequences"), { recursive: true });
    await writeFile(path.join(dataDir, "sequences", `${id}.m3u`), text);
  }
  return seq;
}
app.post("/api/sequences", async (req, res) =>
  res.status(201).json(await saveSequence(req.body, randomUUID())),
);
app.put("/api/sequences/:id", async (req, res) => {
  if (!(req.params.id in (await store.all("sequences"))))
    throw fail(404, "Sequence not found.");
  res.json(await saveSequence(req.body, req.params.id));
});
app.delete("/api/sequences/:id", async (req, res) => {
  await store.remove("sequences", req.params.id);
  if (!cloud && /^[\w-]+$/.test(req.params.id))
    await unlink(path.join(dataDir, "sequences", `${req.params.id}.m3u`)).catch(
      () => {},
    );
  res.json({ ok: true });
});
app.get("/api/sequences/:id/download", async (req, res) => {
  const text = (await store.all("sequences"))[req.params.id];
  if (!text) throw fail(404, "Sequence not found.");
  res
    .set({
      "Content-Type": "audio/x-mpegurl",
      "Content-Disposition": `attachment; filename="${safe(parse(text, await store.all("media")).name)}.m3u"`,
    })
    .send(text);
});
app.post("/api/sequences/import", upload.single("file"), async (req, res) => {
  if (!req.file) throw fail(400, "Choose an M3U file.");
  if (req.file.size > 1024 * 1024)
    throw fail(400, "M3U files must be under 1 MB.");
  const parsed = parse(
    req.file.buffer.toString("utf8"),
    await store.all("media"),
  );
  res.status(201).json(await saveSequence(parsed, randomUUID()));
});
// Local uploads use 2 MB chunks so reverse-proxy body limits do not reject large media.
const rawChunk = express.raw({
  type: "application/octet-stream",
  limit: "3mb",
});
function localUploads(req, res, next) {
  if (cloud || process.env.BLOB_READ_WRITE_TOKEN)
    return next(fail(400, "Use direct Blob uploads in this environment."));
  next();
}
const pendingPath = (id, ext) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw fail(400, "Invalid upload ID.");
  return path.join(dataDir, "uploads", "pending", `${id}.${ext}`);
};
async function pending(id, user) {
  let p;
  try {
    p = JSON.parse(await readFile(pendingPath(id, "json"), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT")
      throw fail(404, "Upload session not found. Start the upload again.");
    throw e;
  }
  if (p.owner !== user.username)
    throw fail(403, "This upload belongs to another account.");
  return p;
}
app.post("/api/uploads", localUploads, async (req, res) => {
  const { filename, name, folder, size, duration } = req.body,
    ext = String(filename || "")
      .split(".")
      .pop()
      .toLowerCase();
  if (!extensions.has(ext))
    throw fail(400, "Unsupported audio or video format.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > 500 * 1024 * 1024)
    throw fail(413, "Media files must be smaller than 500 MB.");
  const id = randomUUID(),
    p = {
      id,
      owner: req.user.username,
      filename: safe(filename),
      name: safe(name) || safe(filename),
      folder: safe(folder) || "Uploads",
      size,
      duration: Number(duration),
      extension: ext.toUpperCase(),
      type: String(req.body.type || "application/octet-stream"),
      createdAt: new Date().toISOString(),
    };
  await mkdir(path.join(dataDir, "uploads", "pending"), { recursive: true });
  await writeFile(pendingPath(id, "part"), Buffer.alloc(0));
  await writeFile(pendingPath(id, "json"), JSON.stringify(p));
  res.status(201).json({ id, chunkSize: 2 * 1024 * 1024 });
});
app.post(
  "/api/uploads/:id/chunks",
  localUploads,
  rawChunk,
  async (req, res) => {
    const p = await pending(req.params.id, req.user),
      file = pendingPath(p.id, "part"),
      offset = Number(req.query.offset),
      current = (await stat(file)).size;
    if (
      !Buffer.isBuffer(req.body) ||
      !req.body.length ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + req.body.length > p.size
    )
      throw fail(400, "Invalid upload chunk.");
    // A retried chunk is accepted when its complete byte range is already present.
    if (offset < current && offset + req.body.length <= current)
      return res.json({ received: current });
    if (offset !== current)
      throw fail(409, `Upload offset mismatch. Expected ${current}.`);
    await appendFile(file, req.body);
    res.json({ received: offset + req.body.length });
  },
);
app.post("/api/uploads/:id/complete", localUploads, async (req, res) => {
  const p = await pending(req.params.id, req.user),
    file = pendingPath(p.id, "part");
  if ((await stat(file)).size !== p.size)
    throw fail(400, "Upload is incomplete. Retry the file.");
  let duration;
  try {
    duration = (await parseFile(file, { duration: true })).format.duration;
  } catch {}
  if (!duration && p.type.startsWith("video/")) duration = p.duration;
  if (!Number.isFinite(duration) || duration <= 0)
    throw fail(
      400,
      "Could not read this media file. It may be damaged or in an unsupported format.",
    );
  const storedFilename = `${p.id}.${p.extension.toLowerCase()}`,
    { owner, ...metadata } = p,
    m = {
      ...metadata,
      duration,
      storedFilename,
      url: `/api/media/${p.id}/file`,
      storage: "disk",
    };
  await rename(file, path.join(dataDir, "uploads", storedFilename));
  await store.put("media", m.id, m);
  await unlink(pendingPath(p.id, "json"));
  res.status(201).json(m);
});
app.delete("/api/uploads/:id", localUploads, async (req, res) => {
  await pending(req.params.id, req.user);
  for (const ext of ["json", "part"])
    await unlink(pendingPath(req.params.id, ext)).catch(() => {});
  res.json({ ok: true });
});
app.post(
  "/api/media",
  (req, res, next) => {
    if (cloud || process.env.BLOB_READ_WRITE_TOKEN)
      return next(fail(400, "Use direct Blob uploads in this environment."));
    next();
  },
  upload.single("file"),
  async (req, res) => {
    if (!req.file) throw fail(400, "Choose an audio or video file.");
    const original = safe(req.file.originalname),
      ext = original.split(".").pop().toLowerCase();
    if (!extensions.has(ext))
      throw fail(400, "Unsupported file. Use audio or video media.");
    let duration;
    try {
      duration = (
        await parseBuffer(
          req.file.buffer,
          { mimeType: req.file.mimetype, size: req.file.size },
          { duration: true },
        )
      ).format.duration;
    } catch {}
    // Some video containers are not supported by music-metadata; the browser probes those.
    if (!duration && req.file.mimetype.startsWith("video/"))
      duration = Number(req.body.duration);
    if (!Number.isFinite(duration) || duration <= 0)
      throw fail(
        400,
        "Could not read the media duration. Try a supported audio or video format.",
      );
    const id = randomUUID(),
      filename = `${id}.${ext}`;
    await mkdir(path.join(dataDir, "uploads"), { recursive: true });
    await writeFile(path.join(dataDir, "uploads", filename), req.file.buffer);
    const m = {
      id,
      name: safe(req.body.name) || original.replace(/\.[^.]+$/, ""),
      filename: original,
      storedFilename: filename,
      folder: safe(req.body.folder) || "Uploads",
      duration,
      type: req.file.mimetype,
      extension: ext.toUpperCase(),
      size: req.file.size,
      url: `/api/media/${id}/file`,
      createdAt: new Date().toISOString(),
      storage: "disk",
    };
    await store.put("media", id, m);
    res.status(201).json(m);
  },
);
app.post("/api/media/blob-complete", async (req, res) => {
  const { url, pathname, metadata } = req.body;
  if (!process.env.BLOB_READ_WRITE_TOKEN)
    throw fail(503, "Blob is not configured.");
  const info = await head(url); // head validates that the URL belongs to this store.
  if (info.pathname !== pathname || !/^media\/[\w-]+\.[\w]+$/.test(pathname))
    throw fail(400, "Invalid upload receipt.");
  // Use the caller-generated UUID; randomized Blob suffixes are after the original UUID.
  const originalId = pathname.slice(6, 42);
  if (!/^[0-9a-f-]{36}$/.test(originalId)) throw fail(400, "Invalid media ID.");
  const old = (await store.all("media"))[originalId];
  if (old) return res.json(old);
  const duration = Number(metadata.duration);
  if (!Number.isFinite(duration) || duration <= 0)
    throw fail(400, "Invalid duration.");
  res
    .status(201)
    .json(
      await registerBlob(
        { ...info, url },
        {
          id: originalId,
          name: safe(metadata.name),
          folder: safe(metadata.folder) || "Uploads",
          duration,
          filename: safe(metadata.filename),
          extension: pathname.split(".").pop().toUpperCase(),
        },
      ),
    );
});
app.get("/api/media/:id/file", async (req, res) => {
  const m = (await store.all("media"))[req.params.id];
  if (!m) throw fail(404, "Media not found.");
  if (m.storage === "disk")
    return res.sendFile(
      path.join(dataDir, "uploads", path.basename(m.storedFilename)),
    );
  res.redirect(m.url);
});
app.patch("/api/media/:id", async (req, res) => {
  const m = (await store.all("media"))[req.params.id];
  if (!m) throw fail(404, "Media not found.");
  m.name = safe(req.body.name) || m.name;
  m.folder = safe(req.body.folder) || m.folder;
  m.description = String(req.body.description || "").slice(0, 1000);
  await store.put("media", m.id, m);
  res.json(m);
});
app.delete("/api/media/:id", async (req, res) => {
  const all = await store.all("media"),
    m = all[req.params.id];
  if (!m) throw fail(404, "Media not found.");
  const used = Object.values(await store.all("sequences")).some((text) =>
    parse(text, all).cues.some((c) => c.mediaId === m.id),
  );
  if (used)
    throw fail(409, "Remove this media from its sequences before deleting it.");
  if (m.storage === "blob") await del(m.url);
  if (m.storage === "disk")
    await unlink(
      path.join(dataDir, "uploads", path.basename(m.storedFilename)),
    ).catch(() => {});
  await store.remove("media", m.id);
  res.json({ ok: true });
});
app.use("/api", (req, res) =>
  res.status(404).json({ error: "API endpoint not found." }),
);
app.use(express.static("public", { index: "index.html" }));
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE")
    err.message =
      "File exceeds the upload limit. Use chunked media uploads (up to 500 MB) or an M3U file under 1 MB.";
  const status =
    err.status ||
    (err instanceof multer.MulterError
      ? 400
      : /Redis|fetch failed|timeout/i.test(err.message)
        ? 503
        : 400);
  if (status >= 500) console.error("SimpleCue:", err.message);
  res.status(status).json({ error: err.message || "Something went wrong." });
});
export default app;
