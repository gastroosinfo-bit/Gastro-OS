// api/push-subscribe.js
// Registriert eine Push-Subscription — entweder vom eingeloggten INHABER (Session-Cookie)
// oder von einem MITARBEITER (Code + persönliche PIN, siehe lib/pin-auth.js). Landet in
// derselben gemeinsamen Liste, damit bei neuen Einträgen gezielt benachrichtigt werden kann.
// Der bookType + mitarbeiterName sorgen dafür, dass z. B. bei einer abgelehnten Zeiterfassung
// NUR die betroffene Person benachrichtigt wird, nicht das ganze Team.
//
// DELETE: Nur der eingeloggte Inhaber kann seine eigene Subscription wieder entfernen
// (z. B. wenn er Benachrichtigungen im Dashboard deaktiviert). Mitarbeiter haben dafür
// bewusst keine eigene Möglichkeit.

const crypto = require('crypto');
const { addSubscription, removeSubscription } = require('../lib/push-helper');
const { pruefeZugang } = require('../lib/pin-auth');

const SESSION_SECRET = process.env.SESSION_SECRET;

function verifySession(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 3) return null;
    const [email, expires, sig] = parts;
    if (Date.now() > parseInt(expires)) return null;
    const data = `${email}|${expires}`;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
    if (sig !== expected) return null;
    return email;
  } catch (e) {
    return null;
  }
}
function getEmailFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/gastro_os_session=([^;]+)/);
  if (!match) return null;
  return verifySession(decodeURIComponent(match[1]));
}

export default async function handler(req, res) {
  // ── DELETE: Chef deaktiviert seine eigene Subscription ──────────────────
  if (req.method === 'DELETE') {
    const email = getEmailFromRequest(req);
    if (!email) return res.status(401).json({ error: 'Nicht angemeldet.' });
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint fehlt.' });
    try {
      await removeSubscription(email, endpoint);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Entfernen.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });

  const { subscription, code, pin, bookType } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Ungültige Subscription.' });
  }

  // ── Fall 1: eingeloggter Inhaber ─────────────────────────────────────
  const email = getEmailFromRequest(req);
  if (email) {
    try {
      await addSubscription(email, subscription);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Speichern.' });
    }
  }

  // ── Fall 2: Mitarbeiter per Code + persönliche PIN ────────────────────
  if (!code || !pin || !['uebergabe', 'reservierung', 'schichtplan', 'zeiterfassung', 'belege', 'temperaturen'].includes(bookType)) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }
  const zugang = await pruefeZugang(bookType, code, pin);
  if (zugang.error) return res.status(zugang.status).json({ error: zugang.error });

  try {
    await addSubscription(zugang.owner.user_id, subscription, bookType, zugang.name);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Fehler beim Speichern.' });
  }
}
