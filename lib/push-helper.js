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

async function sendPushToOwner(userId, title, body, url) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return; // Push nicht konfiguriert — still überspringen

  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
      '&tool_name=eq.push-subscription&select=data&order=updated_at.desc&limit=1',
      { headers: sbHeaders() }
    );
    const rows = await r.json();
    const subscription = (rows && rows.length > 0 && rows[0].data) ? rows[0].data.subscription : null;
    if (!subscription) return;

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, url }));
  } catch (e) {
    // Push-Fehler dürfen den eigentlichen Speichervorgang nie blockieren — einfach stillschweigend ignorieren.
  }
}

module.exports = { sendPushToOwner };
