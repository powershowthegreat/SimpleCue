import { Bucket, BlobError, uploadHandler } from "@upstash/blob";
import { randomUUID } from "node:crypto";
import { store } from "./store.js";
export const MEDIA_PREFIX = "simplecue/media/";
export const mediaExtensions = new Set([
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
export const safeText = (v) =>
  String(v || "")
    .replace(/[^a-zA-Z0-9 ._\-]/g, "")
    .trim()
    .slice(0, 150);
let bucket, handler;
export function blobBucket() {
  if (!process.env.UPSTASH_BLOB_TOKEN)
    throw Object.assign(
      new Error("Set UPSTASH_BLOB_TOKEN to enable Upstash Blob uploads."),
      { status: 503 },
    );
  return (bucket ||= Bucket.fromEnv({ enableTelemetry: false }));
}
const ownerKey = (username) => Buffer.from(username).toString("base64url");
export function uploadMetadata(value) {
  if (!value || typeof value !== "object")
    throw new Error("Media metadata is required.");
  const duration = Number(value.duration);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Could not read the media duration.");
  return {
    name: safeText(value.name),
    folder: safeText(value.folder) || "Uploads",
    duration,
  };
}
function encodedMetadata(data, username) {
  return {
    owner: ownerKey(username),
    simplecue: Buffer.from(JSON.stringify(data)).toString("base64url"),
  };
}
export function recordFromBlob(blob, metadata, username) {
  let p;
  try {
    p = JSON.parse(
      Buffer.from(metadata.simplecue || "", "base64url").toString(),
    );
  } catch {
    throw new BlobError("forbidden", { message: "Invalid upload metadata." });
  }
  if (
    metadata.owner !== ownerKey(username) ||
    !p ||
    !/^[-a-f0-9]{36}$/.test(p.id) ||
    !mediaExtensions.has(String(p.extension).toLowerCase()) ||
    blob.path !== `${MEDIA_PREFIX}${p.id}.${p.extension.toLowerCase()}`
  )
    throw new BlobError("forbidden", {
      message: "Upload does not belong to this account.",
    });
  return {
    ...p,
    size: blob.size,
    type: blob.contentType,
    blobPath: blob.path,
    etag: blob.etag,
    storage: "upstash",
    url: `/api/media/${p.id}/file`,
    createdAt: new Date(blob.uploadedAt).toISOString(),
  };
}
export async function registerBlobMedia(
  blob,
  metadata,
  username,
  targetStore = store,
) {
  const m = recordFromBlob(blob, metadata, username),
    old = (await targetStore.all("media"))[m.id];
  if (old) {
    if (old.storage !== "upstash" || old.blobPath !== m.blobPath)
      throw new BlobError("forbidden", {
        message: "Media ID is already in use.",
      });
    return old;
  }
  await targetStore.put("media", m.id, m);
  return m;
}
export async function finishBlobUpload(blobPath, user) {
  if (
    !new RegExp(
      `^${MEDIA_PREFIX}[a-f0-9-]{36}\\.(wav|mp3|ogg|m4a|aac|flac|aif|aiff|mp4|webm|mov)$`,
    ).test(blobPath)
  )
    throw Object.assign(new Error("Invalid media object path."), {
      status: 400,
    });
  const info = await blobBucket().info(blobPath);
  return registerBlobMedia(info, info.metadata, user.username);
}
export function blobUploadHandler() {
  if (handler) return handler;
  handler = uploadHandler({
    bucket: blobBucket(),
    endpoint: "/api/uploads/blob",
    constraints: {
      maxSize: 500 * 1024 * 1024,
      contentTypes: ["audio/*", "video/*", "audio/aiff", "audio/x-aiff"],
    },
    context: async (request) => {
      const token = /(?:^|;\s*)simplecue_session=([^;]+)/.exec(
        request.headers.get("cookie") || "",
      )?.[1];
      const user = token && (await store.get(`session:${token}`));
      if (!user)
        throw new BlobError("unauthorized", {
          message: "Sign in before uploading.",
        });
      return user;
    },
    input: {
      "~standard": {
        version: 1,
        vendor: "SimpleCue",
        validate(value) {
          try {
            return { value: uploadMetadata(value) };
          } catch (e) {
            return { issues: [{ message: e.message }] };
          }
        },
      },
    },
    onBeforeUpload: ({ ctx, file, input }) => {
      const filename = safeText(file.name),
        ext = filename.split(".").pop().toLowerCase();
      if (!mediaExtensions.has(ext))
        throw new BlobError("invalid_input", {
          message: "Unsupported audio or video file.",
        });
      const id = randomUUID(),
        p = {
          ...input,
          id,
          filename,
          name: input.name || filename.replace(/\.[^.]+$/, ""),
          extension: ext.toUpperCase(),
        };
      return {
        path: `${MEDIA_PREFIX}${id}.${ext}`,
        metadata: encodedMetadata(p, ctx.username),
      };
    },
    onUploadComplete: async (blob) => {
      // Validate signed metadata first; database outages must not cause the SDK to delete valid bytes.
      recordFromBlob(blob, blob.metadata, blob.ctx.username);
      try {
        return {
          media: await registerBlobMedia(
            blob,
            blob.metadata,
            blob.ctx.username,
          ),
        };
      } catch (e) {
        if (BlobError.is(e)) throw e;
        console.error(
          "SimpleCue: upload stored; metadata registration needs retry.",
        );
        return { registrationPending: true, path: blob.path };
      }
    },
  });
  return handler;
}
export async function serveBlobUpload(req, res) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (
      typeof value === "string" &&
      !["content-length", "transfer-encoding"].includes(key)
    )
      headers.set(key, value);
  const request = new Request(`http://simplecue.local${req.originalUrl}`, {
    method: req.method,
    headers,
    ...(req.method === "POST" ? { body: JSON.stringify(req.body) } : {}),
  });
  const result = await blobUploadHandler()[req.method](request);
  res.status(result.status);
  result.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(Buffer.from(await result.arrayBuffer()));
}
export async function migrateMediaRecord(
  m,
  body,
  username = "admin",
  targetStore = store,
) {
  const ext = String(m.extension || m.filename.split(".").pop()).toLowerCase();
  if (!mediaExtensions.has(ext))
    throw new Error("Unsupported existing media type.");
  const p = {
    id: m.id,
    name: m.name,
    filename: m.filename,
    folder: m.folder,
    duration: m.duration,
    description: m.description,
    extension: ext.toUpperCase(),
  };
  const blobPath = `${MEDIA_PREFIX}${m.id}.${ext}`,
    client = blobBucket();
  let info;
  try {
    info = await client.info(blobPath);
  } catch (e) {
    if (e.code !== "not_found") throw e;
  }
  if (!info) {
    await client.put(
      blobPath,
      typeof body === "function" ? await body() : body,
      {
        size: m.size,
        contentType: m.type,
        metadata: encodedMetadata(p, username),
        allowOverwrite: false,
      },
    );
    info = await client.info(blobPath);
  }
  const verified = recordFromBlob(info, info.metadata, username);
  if (info.size !== m.size)
    throw new Error("Stored media size differs from the original.");
  const updated = {
    ...m,
    ...verified,
    createdAt: m.createdAt || verified.createdAt,
  };
  delete updated.storedFilename;
  await targetStore.put("media", m.id, updated);
  return updated;
}

export function sequenceBlobPath(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error("Invalid sequence ID.");
  return `simplecue/sequences/${id}.m3u`;
}
export async function writeSequenceBlob(
  id,
  text,
  { skipUnchanged = false } = {},
) {
  const { createHash } = await import("node:crypto"),
    hash = createHash("sha256").update(text).digest("hex"),
    path = sequenceBlobPath(id),
    client = blobBucket();
  if (skipUnchanged) {
    try {
      const old = await client.info(path);
      if (old.metadata.sha256 === hash) return false;
    } catch (e) {
      if (e.code !== "not_found") throw e;
    }
  }
  await client.put(path, text, {
    contentType: "audio/x-mpegurl",
    metadata: { sha256: hash },
  });
  return true;
}
