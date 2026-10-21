const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SESSION_DAYS = 30;

function hashPassword(password) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(password).digest('hex');
}


// "Nur Zentrale"-Zugänge: Sitzung gilt nur bis der Browser geschlossen wird (Session-Cookie), serverseitig max. 1 Tag
async function istNurZentrale(email) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/filial_gruppen?zentrale_email=eq.${encodeURIComponent(email.toLowerCase())}&nur_zentrale=eq.true&select=zentrale_email&limit=1`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}

function signSession(email, kurz) {
  const expires = Date.now() + (kurz ? 1 : SESSION_DAYS) * 24 * 60 * 60 * 1000;
  const data = `${email}|${expires}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
  return Buffer.from(`${data}|${sig}`).toString('base64');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password } = req.body;

  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Ungültige Eingabe. Passwort muss mindestens 8 Zeichen haben.' });
  }

  const hash = hashPassword(password);

  try {
    // 1) Ein bereits gesetztes Passwort darf hier nie überschrieben werden (dafür gibt es "Passwort vergessen")
    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email.toLowerCase())}&select=password_hash`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!pRes.ok) {
      return res.status(500).json({ error: 'Server-Fehler. Bitte versuche es erneut.' });
    }
    const pRows = await pRes.json();
    if (Array.isArray(pRows) && pRows.length > 0 && pRows[0].password_hash) {
      return res.status(409).json({ error: 'Für diese E-Mail ist schon ein Passwort gesetzt. Bitte melde dich an oder nutze „Passwort vergessen“.' });
    }

    // 2) Nur Adressen mit gültigem Zugang dürfen ein Passwort setzen: gleiche Prüfung wie beim Login (Abo, Demo-Zugang, Zentrale)
    const zRes = await fetch('https://www.mein-gastro-system.de/api/check-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, step: 'check_email' })
    });
    if (!zRes.ok) {
      return res.status(403).json({ error: 'Kein aktiver Zugang für diese E-Mail gefunden.' });
    }

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify({ email: email.toLowerCase(), password_hash: hash })
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error('Supabase Fehler:', err);
      return res.status(500).json({ error: 'Passwort konnte nicht gespeichert werden.' });
    }

    const kurz = await istNurZentrale(email);
    const token = signSession(email, kurz);
    res.setHeader('Set-Cookie',
      `gastro_os_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax` + (kurz ? '' : `; Max-Age=${SESSION_DAYS * 86400}`)
    );

    return res.status(200).json({ success: true, ziel: kurz ? '/zentrale.html' : '/dashboard.html' });

  } catch (err) {
    console.error('Server Fehler:', err);
    return res.status(500).json({ error: 'Server-Fehler. Bitte versuche es erneut.' });
  }
}
