let promise;
export const db = () =>
  (promise ||= new Promise((resolve, reject) => {
    const r = indexedDB.open("simplecue", 1);
    r.onupgradeneeded = () => {
      for (const name of ["assets", "meta", "waves"])
        if (!r.result.objectStoreNames.contains(name))
          r.result.createObjectStore(name);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
export async function cacheGet(store, key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function cacheSet(store, key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(
        tx.error ||
          new Error(
            "Local cache is full. Free some browser storage and try again.",
          ),
      );
  });
}
export async function cacheDelete(store, key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function cacheKeys(store) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).getAllKeys();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function mediaBlob(media) {
  const cached = await cacheGet("assets", `media:${media.id}`);
  if (cached) return cached;
  const r = await fetch(media.url);
  if (!r.ok)
    throw new Error(
      "Media unavailable. Connect to the server or cache this file first.",
    );
  return r.blob();
}
const inFlight = new Map();
export function peaks(media) {
  if (inFlight.has(media.id)) return inFlight.get(media.id);
  const job = (async () => {
    const old = await cacheGet("waves", media.id);
    if (old) return old;
    const blob = await mediaBlob(media);
    if (blob.size > 100 * 1024 * 1024) return null;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    try {
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer()),
        samples = audio.getChannelData(0),
        count = 800,
        result = [];
      for (let i = 0; i < count; i++) {
        const a = Math.floor((i * samples.length) / count),
          b = Math.floor(((i + 1) * samples.length) / count);
        let max = 0;
        for (let k = a; k < b; k += Math.max(1, Math.floor((b - a) / 200)))
          max = Math.max(max, Math.abs(samples[k]));
        result.push(max);
      }
      await cacheSet("waves", media.id, result);
      return result;
    } catch {
      return null;
    } finally {
      await ctx.close();
    }
  })().finally(() => inFlight.delete(media.id));
  inFlight.set(media.id, job);
  return job;
}
