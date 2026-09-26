// Apex Horizon Bank — Service Worker
// Caches the app shell so it loads instantly and works offline.
// Bump CACHE_NAME whenever you deploy changes so old caches get cleared.

const CACHE_NAME = "apex-horizon-v2";

// Add any other static assets you want cached (css, logo images, etc.)
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

// Install: pre-cache the app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    )
  );
  self.clients.claim();
});

// Fetch strategy:
// - API calls (/api/...) always go to the network (never cache banking data/auth)
// - Everything else: network-first, falling back to cache if offline
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API/auth/session requests — always hit the network
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request).catch(() => new Response(
      JSON.stringify({ error: "You're offline. Please reconnect to continue." }),
      { headers: { "Content-Type": "application/json" }, status: 503 }
    )));
    return;
  }

  // Only cache GET requests for static assets
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/index.html")))
  );
});
