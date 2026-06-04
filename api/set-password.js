const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SESSION_DAYS = 30;

function hashPassword(password) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(password).digest('hex');
}

function signSession(email) {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
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
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email.toLowerCase())}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ password_hash: hash })
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error('Supabase Fehler:', err);
      return res.status(500).json({ error: 'Passwort konnte nicht gespeichert werden.' });
    }

    const token = signSession(email);
    res.setHeader('Set-Cookie',
      `gastro_os_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
    );

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Server Fehler:', err);
    return res.status(500).json({ error: 'Server-Fehler. Bitte versuche es erneut.' });
  }
}
