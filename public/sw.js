
const CACHE_VERSION = "michat-v33";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const isCall = data.type === "call";
  const isModeration = data.type === "moderation";
  const isContactRequest = data.type === "contact_request";
  const isGroupInvite = data.type === "group_invite";
  const isGroupMessage = data.type === "group_message";
  const title = isCall ? `📞 ${data.from || "Llamada entrante"}` : isModeration ? `⚠️ ${data.title || "Aviso de moderación"}` : isContactRequest ? "📥 Nueva solicitud de contacto" : isGroupInvite ? `👥 ${data.groupName || "Nuevo grupo"}` : isGroupMessage ? `💬 ${data.groupName || "Grupo"}` : (data.from ? `💬 ${data.from}` : "Mi Chat");
  const body = isCall ? "Llamada entrante" : (data.message || data.body || "Tienes un nuevo mensaje.");
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: isCall ? "incoming-call" : isModeration ? "moderation-notice" : isContactRequest ? `contact-request-${data.username || data.sender || "unknown"}` : isGroupInvite ? `group-invite-${data.groupId || "unknown"}` : isGroupMessage ? `group-message-${data.groupId || "unknown"}` : "chat-message",
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
