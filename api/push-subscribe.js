// api/push-subscribe.js
// Registriert eine Push-Subscription — entweder vom eingeloggten INHABER (Session-Cookie)
// oder von einem MITARBEITER (Code+PIN, kein Login). Landet in derselben gemeinsamen Liste,
// damit bei neuen Einträgen alle benachrichtigt werden können. Der bookType sorgt dafür,
// dass Mitarbeiter nur für ihr eigenes Buch (Übergabe ODER Reservierung) benachrichtigt werden.

const crypto = require('crypto');
const { addSubscription } = require('../lib/push-helper');

const SESSION_SECRET = process.env.SESSION_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };
}
function pinHashUebergabe(code, pin) {
  return crypto.createHmac('sha256', SUPABASE_SERVICE_KEY || 'fallback').update(code + ':' + pin).digest('hex');
}
function pinHashReservierung(code, pin) {
  return crypto.createHmac('sha256', SUPABASE_SERVICE_KEY || 'fallback').update('reservierung:' + code + ':' + pin).digest('hex');
}
async function findOwnerByCode(zugangTool, code) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?tool_name=eq.' + zugangTool + '&data->>code=eq.' + encodeURIComponent(code) + '&select=user_id,data&limit=1',
    { headers: sbHeaders() }
  );
  const rows = await r.json();
  if (!rows || rows.length === 0) return null;
  return rows[0];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });

  const { subscription, code, pin, bookType } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Ungültige Subscription.' });
  }

  // ── Fall 1: eingeloggter Inhaber ─────────────────────────────────────
  const email = getEmailFromRequest(req);
  if (email) {
    try {
      // Keine bookType-Zuordnung: die Chef-Subscription bekommt beide Bücher.
      await addSubscription(email, subscription);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Speichern.' });
    }
  }

  // ── Fall 2: Mitarbeiter per Code+PIN ─────────────────────────────────
  if (!code || !pin || (bookType !== 'uebergabe' && bookType !== 'reservierung')) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }
  const zugangTool = bookType === 'uebergabe' ? 'uebergabe-zugang' : 'reservierung-zugang';
  const owner = await findOwnerByCode(zugangTool, code);
  if (!owner || !owner.data || !owner.data.pinHash) {
    return res.status(401).json({ error: 'Ungültiger Code.' });
  }
  const erwarteterHash = bookType === 'uebergabe' ? pinHashUebergabe(code, pin) : pinHashReservierung(code, pin);
  if (owner.data.pinHash !== erwarteterHash) {
    return res.status(401).json({ error: 'Falsche PIN.' });
  }

  try {
    await addSubscription(owner.user_id, subscription, bookType);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Fehler beim Speichern.' });
  }
}
