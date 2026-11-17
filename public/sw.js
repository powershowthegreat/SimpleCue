const CACHE = "simplecue-shell-v4";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/icons.js",
  "/cache.js",
  "/outbox.js",
  "/media-name.js",
  "/engine.js",
  "/time.js",
  "/upstash-upload.js",
  "/icon.svg",
  "/fonts/inter.woff2",
];
self.addEventListener("install", (e) =>
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  ),
);
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("simplecue-shell-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
let forcedOffline = false,
  modeReceived = false;
const modeReady = new Promise((resolve) => {
  const request = indexedDB.open("simplecue");
  request.onsuccess = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("meta")) {
      db.close();
      resolve();
      return;
    }
    const read = db.transaction("meta").objectStore("meta").get("network-mode");
    read.onsuccess = () => {
      if (!modeReceived) forcedOffline = Boolean(read.result);
      db.close();
      resolve();
    };
    read.onerror = () => {
      db.close();
      resolve();
    };
  };
  request.onerror = () => resolve();
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "NETWORK_MODE") {
    modeReceived = true;
    forcedOffline = Boolean(event.data.offline);
  }
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (
    e.request.method !== "GET" ||
    u.origin !== location.origin ||
    u.pathname.startsWith("/api/") ||
    u.pathname.startsWith("/demo/")
  )
    return;
  if (e.request.mode === "navigate" || SHELL.includes(u.pathname)) {
    e.respondWith(
      modeReady.then(() => {
        if (forcedOffline || self.navigator.onLine === false)
          return caches
            .match(e.request)
            .then(
              (cached) =>
                cached ||
                (e.request.mode === "navigate"
                  ? caches.match("/index.html")
                  : Response.error()),
            );
        return fetch(e.request)
          .then((r) => {
            if (r.ok) {
              const copy = r.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return r;
          })
          .catch(() =>
            caches
              .match(e.request)
              .then(
                (r) =>
                  r ||
                  (e.request.mode === "navigate"
                    ? caches.match("/index.html")
                    : Response.error()),
              ),
          );
      }),
    );
  }
});
