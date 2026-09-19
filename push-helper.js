// lib/push-helper.js
// Gemeinsam genutzt von api/buch-public.js, um dem Inhaber bei einem neuen Eintrag
// eine Browser-Push-Benachrichtigung zu schicken. Liegt bewusst außerhalb von /api/,
// damit daraus keine eigene HTTP-Route entsteht.

const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:info@mein-gastro-system.de';

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };
}

// bookType: 'uebergabe' | 'reservierung' | 'schichtplan' | undefined (undefined = an alle
// Subscriptions senden, die selbst keinem bestimmten Buch zugeordnet sind — z. B. die
// Haupt-Chef-Subscription)
async function sendPushToAll(userId, title, body, url, bookType) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return; // Push nicht konfiguriert — still überspringen

  try {
    const subscriptions = await ladeSubscriptions(userId);
    if (!subscriptions.length) return;

    const relevante = subscriptions.filter(sub => !sub.bookType || sub.bookType === bookType);
    if (!relevante.length) return;

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    const payload = JSON.stringify({ title, body, url, bookType });
    await Promise.all(relevante.map(sub =>
      webpush.sendNotification(sub, payload).catch(() => {})
    ));
  } catch (e) {
    // Push-Fehler dürfen den eigentlichen Speichervorgang nie blockieren — einfach stillschweigend ignorieren.
  }
}

// Sendet NUR an die Geräte eines einzelnen, namentlich bestimmten Mitarbeiters (z. B. wenn
// der Chef einen Zeiterfassungs-Eintrag ablehnt — nur diese eine Person soll das erfahren,
// nicht das ganze Team).
async function sendPushToMitarbeiter(userId, bookType, mitarbeiterName, title, body, url) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  if (!mitarbeiterName) return;

  try {
    const subscriptions = await ladeSubscriptions(userId);
    const relevante = subscriptions.filter(sub => sub.bookType === bookType && sub.mitarbeiterName === mitarbeiterName);
    if (!relevante.length) return;

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    const payload = JSON.stringify({ title, body, url, bookType });
    await Promise.all(relevante.map(sub =>
      webpush.sendNotification(sub, payload).catch(() => {})
    ));
  } catch (e) {
    // still ignorieren, siehe oben
  }
}

// Sendet NUR an die Haupt-Subscription des Chefs (die ohne bookType) — ignoriert
// alle Mitarbeiter-Subscriptions komplett, selbst wenn die zufällig denselben
// bookType haben. Wichtig für Nachrichten, die WIRKLICH nur den Chef betreffen
// (z. B. "Mitarbeiter X hat sich eingestempelt") — die dürfen nicht an andere
// Mitarbeiter gehen, nur weil die zufällig für denselben Bereich angemeldet sind.
async function sendPushNurAnChef(userId, title, body, url) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  try {
    const subscriptions = await ladeSubscriptions(userId);
    const relevante = subscriptions.filter(sub => !sub.bookType);
    if (!relevante.length) return;

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    const payload = JSON.stringify({ title, body, url });
    await Promise.all(relevante.map(sub =>
      webpush.sendNotification(sub, payload).catch(() => {})
    ));
  } catch (e) {}
}

async function ladeSubscriptions(userId) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.push-subscriptions&select=data&order=updated_at.desc&limit=1',
    { headers: sbHeaders() }
  );
  const rows = await r.json();
  return (rows && rows.length > 0 && rows[0].data && rows[0].data.subscriptions) ? rows[0].data.subscriptions : [];
}

// bookType: 'uebergabe' | 'reservierung' | 'schichtplan' | 'zeiterfassung' | 'belege' |
// 'temperaturen' | undefined. mitarbeiterName: nur bei Mitarbeiter-Subscriptions gesetzt —
// macht gezielten Versand an genau diese Person möglich (siehe sendPushToMitarbeiter).
async function addSubscription(userId, subscription, bookType, mitarbeiterName) {
  const existingRes = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.push-subscriptions&select=id,data&order=updated_at.desc',
    { headers: sbHeaders() }
  );
  const existingRows = await existingRes.json();
  const bestehende = (existingRows && existingRows.length > 0 && existingRows[0].data && existingRows[0].data.subscriptions) ? existingRows[0].data.subscriptions : [];
  const gefiltert = bestehende.filter(s => s.endpoint !== subscription.endpoint); // Duplikate vermeiden
  let subMitTyp = subscription;
  if (bookType) subMitTyp = { ...subMitTyp, bookType };
  if (mitarbeiterName) subMitTyp = { ...subMitTyp, mitarbeiterName };
  const neueListe = [...gefiltert, subMitTyp];
  const payload = { data: { subscriptions: neueListe }, updated_at: new Date().toISOString() };

  if (existingRows && existingRows.length > 0) {
    await fetch(SUPABASE_URL + '/rest/v1/user_tool_data?id=eq.' + existingRows[0].id, {
      method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(payload)
    });
  } else {
    await fetch(SUPABASE_URL + '/rest/v1/user_tool_data', {
      method: 'POST',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ user_id: userId, tool_name: 'push-subscriptions', data: { subscriptions: neueListe } })
    });
  }
}

// Entfernt Subscriptions für einen endpoint — mit bookType nur den EINEN Bereich
// (z. B. wenn ein Mitarbeiter nur "Reservierung" abschaltet), ohne bookType alle
// Einträge für dieses Gerät (z. B. wenn der Chef Benachrichtigungen komplett aus macht).
async function removeSubscription(userId, endpoint, bookType) {
  const existingRes = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.push-subscriptions&select=id,data&order=updated_at.desc',
    { headers: sbHeaders() }
  );
  const existingRows = await existingRes.json();
  if (!existingRows || existingRows.length === 0) return;

  const bestehende = (existingRows[0].data && existingRows[0].data.subscriptions) ? existingRows[0].data.subscriptions : [];
  const neueListe = bestehende.filter(s => {
    if (s.endpoint !== endpoint) return true;
    if (bookType) return s.bookType !== bookType; // nur diesen einen Bereich raus
    return false; // kein bookType angegeben -> alles für diesen endpoint raus
  });
  const payload = { data: { subscriptions: neueListe }, updated_at: new Date().toISOString() };

  await fetch(SUPABASE_URL + '/rest/v1/user_tool_data?id=eq.' + existingRows[0].id, {
    method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(payload)
  });
}

module.exports = { sendPushToAll, sendPushToMitarbeiter, sendPushNurAnChef, addSubscription, removeSubscription };