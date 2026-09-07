// api/beleg-upload.js
// Upload und signierter Abruf von Beleg-PDFs (Lieferdienst-Abrechnungen etc.) über Supabase Storage.
// Nutzt denselben Session-Cookie-Auth-Mechanismus wie api/tool-data.js.

const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'belege';

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

function safeFileName(name) {
  return String(name || 'beleg.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
}

export default async function handler(req, res) {
  const email = getEmailFromRequest(req);
  if (!email) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }

  // ─── POST: Datei hochladen ─────────────────────────────────────────────
  if (req.method === 'POST') {
    const { filename, contentBase64, contentType } = req.body || {};
    if (!filename || !contentBase64) {
      return res.status(400).json({ error: 'filename oder contentBase64 fehlt.' });
    }
    try {
      const buffer = Buffer.from(contentBase64, 'base64');
      // ~8MB Sicherheitsgrenze, damit die Vercel Function nicht am Body-Limit scheitert
      if (buffer.length > 8 * 1024 * 1024) {
        return res.status(413).json({ error: 'Datei zu groß (max. 8 MB).' });
      }
      const path = `${encodeURIComponent(email)}/${Date.now()}-${safeFileName(filename)}`;
      const uploadRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
        {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
            'Content-Type': contentType || 'application/pdf'
          },
          body: buffer
        }
      );
      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        return res.status(502).json({ error: 'Upload fehlgeschlagen.', detail: errText });
      }
      return res.status(200).json({ path });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Hochladen.' });
    }
  }

  // ─── GET: Signierte URL zum Anzeigen/Herunterladen erzeugen ────────────
  if (req.method === 'GET') {
    const path = req.query.path;
    if (!path) return res.status(400).json({ error: 'path fehlt.' });
    // Nur Dateien im eigenen Ordner (email-Präfix) dürfen abgerufen werden
    if (!path.startsWith(encodeURIComponent(email) + '/')) {
      return res.status(403).json({ error: 'Kein Zugriff.' });
    }
    try {
      const signRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`,
        {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ expiresIn: 3600 })
        }
      );
      const signData = await signRes.json();
      if (!signRes.ok || !signData.signedURL) {
        return res.status(502).json({ error: 'Signierte URL konnte nicht erstellt werden.' });
      }
      return res.status(200).json({ url: SUPABASE_URL + '/storage/v1' + signData.signedURL });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Abrufen.' });
    }
  }

  // ─── DELETE: Datei löschen ──────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { path } = req.body || {};
    if (!path) return res.status(400).json({ error: 'path fehlt.' });
    if (!path.startsWith(encodeURIComponent(email) + '/')) {
      return res.status(403).json({ error: 'Kein Zugriff.' });
    }
    try {
      await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
        }
      });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Löschen.' });
    }
  }

  return res.status(405).json({ error: 'Methode nicht erlaubt.' });
}
