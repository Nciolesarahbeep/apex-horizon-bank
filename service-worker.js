// Apex Horizon Bank — Service Worker
// Caches the app shell so it loads instantly and works offline.
// Bump CACHE_NAME whenever you deploy changes so old caches get cleared.

const CACHE_NAME = "apex-horizon-v4";

// Add any other static assets you want cached (css, logo images, etc.)
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/badge-96.png"
];

// Install: pre-cache the app shell
// Each file is cached on its own, so one missing file can't stop the worker
// installing (cache.addAll fails the whole install if any request fails, and
// without an installed worker there are no push notifications).
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    )
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

// ---------------------------------------------------------------------------
// Push notifications
// The server encrypts each alert for this device; the browser decrypts it
// before this runs, so event.data is the plain JSON the server sent:
// { id, title, body, tag, url, badge, ts }.
// ---------------------------------------------------------------------------
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Apex Horizon Bank", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Apex Horizon Bank";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: data.tag || undefined,
    timestamp: data.ts || Date.now(),
    data: { url: data.url || "/", id: data.id || null },
  };
  const jobs = [self.registration.showNotification(title, options)];
  // The unread count on the app icon (iPhone Home Screen apps, Android, desktop).
  if (typeof data.badge === "number" && self.navigator && "setAppBadge" in self.navigator) {
    jobs.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(jobs).catch(() => {}));
});

// Tapping an alert opens the app (or brings it to the front) on the alerts list.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  const target = new URL(url, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin)) {
          client.postMessage({ type: "ahb-open-notifications" });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

// If the browser renews this device's push address, tell the server the new
// one (same-origin, so the sign-in cookie comes along).
self.addEventListener("pushsubscriptionchange", (event) => {
  const old = event.oldSubscription;
  const key = old && old.options && old.options.applicationServerKey;
  if (!key) return;
  event.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).then((sub) =>
      fetch("/api/account-services", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "push", pushAction: "subscribe", subscription: sub.toJSON() }),
      })
    ).catch(() => {})
  );
});
