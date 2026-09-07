// api/zugang-setup.js
// Ersetzt die früheren getrennten Dateien uebergabe-setup.js und reservierung-setup.js
// (zusammengelegt, weil Vercel Hobby maximal 12 Serverless Functions erlaubt).
// Nur für eingeloggte Abonnenten: legt Code+PIN für den Übergabe- ODER Reservierungsbuch-Zugang
// fest (je nach "bookType") oder ändert die PIN. Die PIN wird nie im Klartext gespeichert,
// nur als Hash (Code als Salt) — derselbe Algorithmus wie in uebergabe-public.js / reservierung-public.js.

const crypto = require('crypto');

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
// Gleiche Hash-Formeln wie in uebergabe-public.js / reservierung-public.js
function pinHashUebergabe(code, pin) {
  return crypto.createHmac('sha256', SUPABASE_SERVICE_KEY || 'fallback').update(code + ':' + pin).digest('hex');
}
function pinHashReservierung(code, pin) {
  return crypto.createHmac('sha256', SUPABASE_SERVICE_KEY || 'fallback').update('reservierung:' + code + ':' + pin).digest('hex');
}

export default async function handler(req, res) {
  const email = getEmailFromRequest(req);
  if (!email) return res.status(401).json({ error: 'Nicht angemeldet.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });

  const { code, pin, bookType } = req.body || {};
  if (!code || !pin || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'Code oder vierstellige PIN fehlt/ungültig.' });
  }
  if (bookType !== 'uebergabe' && bookType !== 'reservierung') {
    return res.status(400).json({ error: 'Ungültiger bookType.' });
  }

  const zugangTool = bookType === 'uebergabe' ? 'uebergabe-zugang' : 'reservierung-zugang';
  const hash = bookType === 'uebergabe' ? pinHashUebergabe(code, pin) : pinHashReservierung(code, pin);
  const data = { code, pinHash: hash };

  try {
    const existingRes = await fetch(
      SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(email) +
      '&tool_name=eq.' + zugangTool + '&select=id&order=updated_at.desc',
      { headers: sbHeaders() }
    );
    const existingRows = await existingRes.json();

    if (existingRows && existingRows.length > 0) {
      await fetch(SUPABASE_URL + '/rest/v1/user_tool_data?id=eq.' + existingRows[0].id, {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({ data, updated_at: new Date().toISOString() })
      });
    } else {
      await fetch(SUPABASE_URL + '/rest/v1/user_tool_data', {
        method: 'POST',
        headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: email, tool_name: zugangTool, data })
      });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Fehler beim Speichern.' });
  }
}
