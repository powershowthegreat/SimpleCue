const CACHE = "simplecue-shell-v2";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/icons.js",
  "/cache.js",
  "/engine.js",
  "/time.js",
  "/blob-client.js",
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
      fetch(e.request)
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
        ),
    );
  }
});
