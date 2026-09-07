// sw.js — Service Worker für GASTRO-OS Push-Benachrichtigungen (Übergabebuch & Reservierungsbuch)

self.addEventListener('push', function(event) {
  let payload = { title: 'GASTRO-OS', body: 'Neue Nachricht.' };
  try {
    if (event.data) payload = event.data.json();
  } catch (e) {}

  const options = {
    body: payload.body,
    data: { url: payload.url || '/dashboard.html' }
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/dashboard.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
