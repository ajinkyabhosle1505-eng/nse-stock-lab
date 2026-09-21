/* NSE Stock Lab — basic offline cache for static assets + /data/*.json */
const CACHE = "stock-lab-v1";
const PRECACHE = [
  "/",
  "/ideas",
  "/budget",
  "/report",
  "/paper",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon.svg",
  "/apple-touch-icon.png",
  "/data/verdicts.json",
  "/data/daily_report.json",
  "/data/ledger.json",
  "/data/tech.json",
  "/data/funda.json",
  "/data/news.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isData = url.pathname.startsWith("/data/") && url.pathname.endsWith(".json");
  const isStatic =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.match(/\.(js|css|png|svg|webmanifest|ico|woff2?)$/);

  if (isData || isStatic || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok) cache.put(request, fresh.clone());
          return fresh;
        } catch {
          const cached = await cache.match(request);
          if (cached) return cached;
          throw new Error("offline and uncached: " + url.pathname);
        }
      })
    );
  }
});
