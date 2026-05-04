const crypto = require('crypto');

const WHOP_API_KEY = process.env.WHOP_API_KEY;
const WHOP_PRODUCT_ID = process.env.WHOP_PRODUCT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;
const BYPASS_EMAILS = process.env.BYPASS_EMAILS || '';
const SESSION_DAYS = 30;

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

  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse' });
  }

  // Whitelist-Check (für interne Nutzer)
  const bypassList = BYPASS_EMAILS.split(',').map(e => e.trim().toLowerCase());
  if (bypassList.includes(email.toLowerCase())) {
    const token = signSession(email);
    res.setHeader('Set-Cookie',
      `gastro_os_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
    );
    return res.status(200).json({ success: true });
  }

  // Whop API v5 — Mitglieder nach E-Mail suchen
  try {
    const response = await fetch(
      `https://api.whop.com/v5/app/members?page=1`,
      {
        headers: {
          'Authorization': `Bearer ${WHOP_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      console.error('Whop API Fehler:', response.status, await response.text());
      return res.status(500).json({ error: 'Whop API nicht erreichbar' });
    }

    const data = await response.json();
    const members = data.data || [];

    const activeMember = members.find(m =>
      m.email?.toLowerCase() === email.toLowerCase()
    );

    if (!activeMember) {
      return res.status(403).json({
        error: 'Kein aktives Gastro-OS Abonnement für diese E-Mail gefunden.'
      });
    }

    const token = signSession(email);
    res.setHeader('Set-Cookie',
      `gastro_os_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
    );
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Auth Fehler:', err);
    return res.status(500).json({ error: 'Server-Fehler. Bitte versuche es erneut.' });
  }
}
