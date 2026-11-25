// lib/push-helper.js
// Gemeinsam genutzt von api/buch-public.js, um dem Inhaber bei einem neuen Eintrag
// eine Browser-Push-Benachrichtigung zu schicken. Liegt bewusst außerhalb von /api/,
// damit daraus keine eigene HTTP-Route entsteht.

const webpush = require('web-push');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:info@mein-gastro-system.de';


// ── Push für die GASTRO-OS-Android-App (Firebase Cloud Messaging) ───────────────
// Geräte der App werden wie Browser-Geräte in derselben Liste gespeichert, haben aber
// statt "endpoint" einen Eintrag "fcm:<Token>" und das Feld fcmToken. Benötigt die
// Umgebungsvariable FIREBASE_SERVICE_ACCOUNT (kompletter JSON-Inhalt des Dienstkonto-
// Schlüssels aus der Firebase-Konsole). Fehlt sie, werden App-Geräte still übersprungen.
let fcmCache = null; // { token, exp }

function fcmKonto() {
  const roh = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!roh) return null;
  try { return JSON.parse(roh); } catch (e) { return null; }
}

function b64url(x) {
  return Buffer.from(x).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function fcmAccessToken(konto) {
  const jetzt = Math.floor(Date.now() / 1000);
  if (fcmCache && fcmCache.exp - 60 > jetzt) return fcmCache.token;
  const kopf = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const inhalt = b64url(JSON.stringify({
    iss: konto.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: jetzt,
    exp: jetzt + 3600
  }));
  const signatur = crypto.createSign('RSA-SHA256').update(kopf + '.' + inhalt).sign(konto.private_key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
          '&assertion=' + kopf + '.' + inhalt + '.' + b64url(signatur)
  });
  const daten = await res.json();
  if (!res.ok || !daten.access_token) throw new Error('FCM-Anmeldung fehlgeschlagen');
  fcmCache = { token: daten.access_token, exp: jetzt + (daten.expires_in || 3600) };
  return fcmCache.token;
}

// payload: JSON-Text wie für web-push ({ title, body, url, bookType })
async function sendFcm(konto, fcmToken, payload) {
  const p = JSON.parse(payload);
  const zugang = await fcmAccessToken(konto);
  const res = await fetch('https://fcm.googleapis.com/v1/projects/' + konto.project_id + '/messages:send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + zugang },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title: String(p.title || 'GASTRO-OS'), body: String(p.body || '') },
        data: { url: String(p.url || '/dashboard.html'), bookType: String(p.bookType || '') },
        android: { priority: 'HIGH' }
      }
    })
  });
  if (!res.ok) {
    const err = new Error('FCM ' + res.status);
    err.statusCode = res.status; // 404 = Token existiert nicht mehr -> wird aufgeräumt
    throw err;
  }
}

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };
}

// Verschickt an alle übergebenen Subscriptions, zählt Erfolge/Fehler und ENTFERNT
// automatisch tote Anmeldungen (Push-Dienst antwortet 404/410 = Gerät/Installation existiert
// nicht mehr). Ohne dieses Aufräumen sammeln sich bei jedem Zurücksetzen/Neuinstallieren
// alte Einträge an, die bei jedem Versand mitgeschickt werden.
async function sendeUndRaeumeAuf(userId, relevante, payload, label) {
  const tot = [];
  const fehler = {};
  let ok = 0;
  const konto = fcmKonto();
  await Promise.all(relevante.map(sub => {
    let versand;
    if (sub.fcmToken) {
      // App-Gerät: ohne Firebase-Schlüssel still überspringen
      versand = konto ? sendFcm(konto, sub.fcmToken, payload) : Promise.resolve();
    } else {
      versand = webpush.sendNotification(sub, payload);
    }
    return versand.then(() => { ok++; }).catch(err => {
      const code = (err && err.statusCode) ? String(err.statusCode) : 'unbekannt';
      fehler[code] = (fehler[code] || 0) + 1;
      if (code === '404' || code === '410') tot.push(sub);
    });
  }));
  console.log('[PUSH-ERGEBNIS]', label, '— versucht:', relevante.length, '— zugestellt:', ok,
    '— Fehler nach Code:', JSON.stringify(fehler), '— tot entfernt:', tot.length);
  if (tot.length) {
    try { await entferneTote(userId, tot); } catch (e) {}
  }
}

async function entferneTote(userId, tote) {
  const schluessel = s => (s.endpoint || '') + '|' + (s.bookType || '');
  const weg = new Set(tote.map(schluessel));
  const res = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.push-subscriptions&select=id,data&order=updated_at.desc',
    { headers: sbHeaders() }
  );
  const rows = await res.json();
  if (!rows || rows.length === 0) return;
  const aktuell = (rows[0].data && rows[0].data.subscriptions) ? rows[0].data.subscriptions : [];
  const neueListe = aktuell.filter(s => !weg.has(schluessel(s)));
  if (neueListe.length === aktuell.length) return;
  await fetch(SUPABASE_URL + '/rest/v1/user_tool_data?id=eq.' + rows[0].id, {
    method: 'PATCH', headers: sbHeaders(),
    body: JSON.stringify({ data: { subscriptions: neueListe }, updated_at: new Date().toISOString() })
  });
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
    await sendeUndRaeumeAuf(userId, relevante, payload, 'ToAll ' + title);
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
    await sendeUndRaeumeAuf(userId, relevante, payload, 'AnMitarbeiter ' + title);
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
    console.log('[DEBUG sendPushNurAnChef]', title, '— insgesamt gespeichert:', subscriptions.length,
      '— davon ohne bookType (an Chef gehen):', relevante.length,
      '— alle Einträge:', JSON.stringify(subscriptions.map(s => ({ bookType: s.bookType || null, mitarbeiterName: s.mitarbeiterName || null, endpointEnde: (s.endpoint || '').slice(-12) }))));
    if (!relevante.length) return;

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    const payload = JSON.stringify({ title, body, url });
    await sendeUndRaeumeAuf(userId, relevante, payload, 'NurAnChef ' + title);
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
  const gefiltert = bestehende.filter(s => !(s.endpoint === subscription.endpoint && s.bookType === bookType)); // nur dieselbe Bereich+Gerät-Kombi ersetzen, andere Bereiche auf demselben Gerät bleiben erhalten
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
