import { cacheGet, cacheKeys, cacheUpdate } from "./cache.js";
const keyFor = (owner, kind, id) => JSON.stringify([owner, kind, id]);
export async function queueChange(owner, kind, id, operation, data) {
  if (!owner) throw new Error("Sign in before saving changes.");
  const key = keyFor(owner, kind, id),
    revision = crypto.randomUUID(),
    snapshot = structuredClone(data);
  return cacheUpdate("outbox", key, (old) => ({
    key,
    owner,
    kind,
    id,
    operation:
      operation === "delete"
        ? "delete"
        : old?.operation === "create"
          ? "create"
          : operation,
    data:
      kind === "media" || kind === "preferences"
        ? { ...old?.data, ...snapshot }
        : snapshot,
    revision,
    createdAt: old?.createdAt || Date.now(),
    updatedAt: Date.now(),
    error: old?.error?.status === 404 ? old.error : null,
  }));
}
export async function queuedChanges(owner) {
  const entries = await Promise.all(
    (await cacheKeys("outbox")).map((key) => cacheGet("outbox", key)),
  );
  return entries
    .filter((e) => e?.owner === owner)
    .sort((a, b) => a.createdAt - b.createdAt);
}
export async function acknowledge(entry) {
  return cacheUpdate("outbox", entry.key, (current) =>
    current?.revision === entry.revision ? undefined : current,
  );
}
export async function blockChange(entry, error) {
  return cacheUpdate("outbox", entry.key, (current) =>
    current
      ? {
          ...current,
          error: { status: error.status || 400, message: error.message },
        }
      : undefined,
  );
}
export async function retryChanges(owner) {
  for (const entry of await queuedChanges(owner))
    await cacheUpdate("outbox", entry.key, (current) =>
      current ? { ...current, error: null } : undefined,
    );
}
