// lib/push-helper.js
// Gemeinsam genutzt von api/uebergabe-public.js und api/reservierung-public.js,
// um dem Inhaber bei einem neuen Eintrag eine Browser-Push-Benachrichtigung zu schicken.
// Liegt bewusst außerhalb von /api/, damit daraus keine eigene HTTP-Route entsteht.

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

// bookType: 'uebergabe' | 'reservierung' | undefined (undefined = an alle Subscriptions
// senden, die selbst keinem bestimmten Buch zugeordnet sind — z. B. die Haupt-Chef-Subscription)
async function sendPushToAll(userId, title, body, url, bookType) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return; // Push nicht konfiguriert — still überspringen

  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
      '&tool_name=eq.push-subscriptions&select=data&order=updated_at.desc&limit=1',
      { headers: sbHeaders() }
    );
    const rows = await r.json();
    const subscriptions = (rows && rows.length > 0 && rows[0].data && rows[0].data.subscriptions) ? rows[0].data.subscriptions : [];
    if (!subscriptions.length) return;

    // Nur an Subscriptions senden, die zu diesem bookType passen ODER
    // gar keinem bookType zugeordnet sind (z. B. die Chef-eigene Subscription).
    const relevante = subscriptions.filter(sub => !sub.bookType || sub.bookType === bookType);
    if (!relevante.length) return;

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    const payload = JSON.stringify({ title, body, url });
    await Promise.all(relevante.map(sub =>
      webpush.sendNotification(sub, payload).catch(() => {})
    ));
  } catch (e) {
    // Push-Fehler dürfen den eigentlichen Speichervorgang nie blockieren — einfach stillschweigend ignorieren.
  }
}

// bookType: 'uebergabe' | 'reservierung' | undefined
async function addSubscription(userId, subscription, bookType) {
  const existingRes = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.push-subscriptions&select=id,data&order=updated_at.desc',
    { headers: sbHeaders() }
  );
  const existingRows = await existingRes.json();
  const bestehende = (existingRows && existingRows.length > 0 && existingRows[0].data && existingRows[0].data.subscriptions) ? existingRows[0].data.subscriptions : [];
  const gefiltert = bestehende.filter(s => s.endpoint !== subscription.endpoint); // Duplikate vermeiden
  const subMitTyp = bookType ? { ...subscription, bookType } : subscription;
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

module.exports = { sendPushToAll, addSubscription };
