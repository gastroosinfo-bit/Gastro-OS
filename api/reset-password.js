const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;
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

  const { email, token, password } = req.body;

  if (!email || !token || !password || password.length < 8) {
    return res.status(400).json({ error: 'Ungültige Eingabe.' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  const tokenRes = await fetch(
    `${SUPABASE_URL}/rest/v1/password_resets?email=eq.${encodeURIComponent(normalizedEmail)}&token=eq.${token}&used=eq.false&select=id,expires_at`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      }
    }
  );
  const tokens = await tokenRes.json();

  if (!tokens || tokens.length === 0) {
    return res.status(403).json({ error: 'Ungültiger oder bereits verwendeter Link.' });
  }

  const resetEntry = tokens[0];

  if (new Date(resetEntry.expires_at) < new Date()) {
    return res.status(403).json({ error: 'Der Link ist abgelaufen. Bitte fordere einen neuen an.' });
  }

  const hash = hashPassword(password);
  await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ email: normalizedEmail, password_hash: hash })
  });

  await fetch(`${SUPABASE_URL}/rest/v1/password_resets?id=eq.${resetEntry.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ used: true })
  });

  const sessionToken = signSession(normalizedEmail);
  res.setHeader('Set-Cookie',
    `gastro_os_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
  );

  return res.status(200).json({ success: true });
}
