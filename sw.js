/* Offline shell for Poker Santa Cruz.
 *
 * Navigations are served from cache immediately and refreshed in the
 * background (stale-while-revalidate). Network-first meant every launch sat
 * waiting on the network before showing anything, which at a table on poor
 * signal is the difference between instant and several seconds. The cost is
 * that a deploy is picked up on the next launch rather than this one.
 *
 * Static assets are cache-first. Anything cross-origin (the sync database) is
 * left alone. */

const CACHE = "psc-v2";
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    e.respondWith(
      caches.match("./index.html").then((hit) => {
        const fresh = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put("./index.html", copy));
            }
            return res;
          })
          .catch(() => hit);
        // cached copy now, network in the background
        return hit || fresh;
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
