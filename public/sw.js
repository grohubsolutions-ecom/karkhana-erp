/* Hub service worker — notifications only (H290, 5 Oct 2026).
 *
 * It does ONE job: show a notification when the server pushes one, and open
 * the portal when it is tapped. It deliberately has NO 'fetch' handler, so it
 * never caches or intercepts a single request — the app behaves exactly as it
 * does without it, and this cannot break any screen.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: "Grohub Hub", body: event.data && event.data.text ? event.data.text() : "" }; }
  const title = data.title || "Grohub Hub";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/badge-72.png",
    tag: data.tag || undefined,          // same tag replaces, so a phone is not buried
    data: { url: data.url || "/me" },
    vibrate: [80, 40, 80],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/me";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) { c.navigate(url); return c.focus(); } }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
