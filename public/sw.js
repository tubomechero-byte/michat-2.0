
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const isCall = data.type === "call";
  const title = isCall ? `📞 ${data.from || "Llamada entrante"}` : (data.from ? `💬 ${data.from}` : "Mi Chat");
  const body = isCall ? "Llamada entrante" : (data.message || "Tienes un nuevo mensaje.");
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: isCall ? "incoming-call" : "chat-message",
      renotify: true,
      data: { username: data.username || "", type: data.type || "message" }
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({type:"window", includeUncontrolled:true}).then(list => {
      if (list.length) return list[0].focus();
      return clients.openWindow("/");
    })
  );
});
