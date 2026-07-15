// api/tool-data.js
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

export default async function handler(req, res) {
  const email = getEmailFromRequest(req);
  if (!email) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }

  // ─── GET: Zustand laden ───────────────────────────────────────────────────
  if (req.method === 'GET') {
    const tool = req.query.tool;
    if (!tool) return res.status(400).json({ error: 'tool fehlt.' });

    try {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(email) +
        '&tool_name=eq.' + encodeURIComponent(tool) + '&select=data',
        { headers: sbHeaders() }
      );
      const rows = await r.json();
      const data = (rows && rows.length > 0 && rows[0].data) ? rows[0].data : {};
      return res.status(200).json({ data });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Laden.' });
    }
  }

  // ─── POST: Zustand speichern ──────────────────────────────────────────────
  if (req.method === 'POST') {
    const { tool, data } = req.body || {};
    if (!tool) return res.status(400).json({ error: 'tool fehlt.' });

    try {
      await fetch(SUPABASE_URL + '/rest/v1/user_tool_data', {
        method: 'POST',
        headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          user_id: email,
          tool_name: tool,
          data: data || {},
          updated_at: new Date().toISOString()
        })
      });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Speichern.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
