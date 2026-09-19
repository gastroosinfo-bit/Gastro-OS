// sw.js — Service Worker für GASTRO-OS Push-Benachrichtigungen (Übergabebuch, Reservierungsbuch, Schichtplan)
// Enthält zusätzlich die Badging API: setzt eine Zahl aufs Homescreen-Icon (funktioniert
// zuverlässig auf iPhone ab iOS 16.4, wenn die Seite zum Homescreen hinzugefügt wurde;
// auf Android gibt es dafür keine Web-API — dort zeigt das Betriebssystem selbst automatisch
// einen Punkt/eine Zahl an, solange Benachrichtigungen ungelesen in der Leiste liegen).

function badgeDbOeffnen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('gastroos-badge', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('zaehler');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function badgeZaehlerLesen() {
  try {
    const db = await badgeDbOeffnen();
    return await new Promise((resolve) => {
      const tx = db.transaction('zaehler', 'readonly');
      const req = tx.objectStore('zaehler').get('count');
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
  } catch (e) { return 0; }
}
async function badgeZaehlerSchreiben(wert) {
  try {
    const db = await badgeDbOeffnen();
    await new Promise((resolve) => {
      const tx = db.transaction('zaehler', 'readwrite');
      tx.objectStore('zaehler').put(wert, 'count');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (e) {}
}
async function badgeErhoehen(bookType) {
  let gesamt = 0;
  try {
    const db = await badgeDbOeffnen();
    gesamt = await new Promise((resolve) => {
      const tx = db.transaction('zaehler', 'readwrite');
      const store = tx.objectStore('zaehler');
      let neuGesamt = 0;
      const getGesamt = store.get('count');
      getGesamt.onsuccess = () => {
        neuGesamt = (getGesamt.result || 0) + 1;
        store.put(neuGesamt, 'count');
        if (bookType) {
          const getBereich = store.get('bereich-' + bookType);
          getBereich.onsuccess = () => { store.put((getBereich.result || 0) + 1, 'bereich-' + bookType); };
        }
      };
      tx.oncomplete = () => resolve(neuGesamt);
      tx.onerror = () => resolve(0);
    });
  } catch (e) {}
  if ('setAppBadge' in self.navigator) {
    try { await self.navigator.setAppBadge(gesamt); } catch (e) {}
  }
}
async function badgeZuruecksetzen() {
  await badgeZaehlerSchreiben(0);
  if ('clearAppBadge' in self.navigator) {
    try { await self.navigator.clearAppBadge(); } catch (e) {}
  }
}

self.addEventListener('push', function(event) {
  let payload = { title: 'GASTRO-OS', body: 'Neue Nachricht.' };
  try {
    if (event.data) payload = event.data.json();
  } catch (e) {}

  const options = {
    body: payload.body,
    data: { url: payload.url || '/dashboard.html', bookType: payload.bookType }
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title, options),
      badgeErhoehen(payload.bookType)
    ])
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/dashboard.html';
  event.waitUntil(
    Promise.all([
      badgeZuruecksetzen(),
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
        for (const client of clientList) {
          if (client.url.includes(url) && 'focus' in client) return client.focus();
        }
        if (clients.openWindow) return clients.openWindow(url);
      })
    ])
  );
});