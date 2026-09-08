// api/push-notify.js
// Wird aufgerufen, wenn der eingeloggte INHABER selbst einen Übergabe- oder Reservierungs-
// Eintrag macht (über die normale, authentifizierte Ansicht) — löst dieselbe Push-Benachrichtigung
// an alle registrierten Geräte aus, die zu diesem Buch gehören (Chef + passende Mitarbeiter).

const crypto = require('crypto');
const { sendPushToAll } = require('../lib/push-helper');

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
  const email = getEmailFromRequest(req);
  if (!email) return res.status(401).json({ error: 'Nicht angemeldet.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });

  const { title, body, url, bookType } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title oder body fehlt.' });

  try {
    await sendPushToAll(email, title, body, url || '/dashboard.html', bookType);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Push-Versand fehlgeschlagen:', err);
    return res.status(200).json({ ok: true, warning: 'push_failed' });
  }
}
