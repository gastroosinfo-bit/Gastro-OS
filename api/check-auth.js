// api/check-auth.js
// Vercel Serverless Function – prüft ob E-Mail ein aktives Whop-Abo hat

const crypto = require('crypto');

const WHOP_API_KEY = process.env.WHOP_API_KEY;
const WHOP_PRODUCT_ID = process.env.WHOP_PRODUCT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;
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

  try {
    // Whop API: Mitgliedschaften für diese E-Mail abrufen
    const response = await fetch(
      `https://api.whop.com/api/v2/memberships?status=active&valid=true&page=1`,
      {
        headers: {
          'Authorization': `Bearer ${WHOP_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      console.error('Whop API Fehler:', response.status);
      return res.status(500).json({ error: 'Whop API nicht erreichbar' });
    }

    const data = await response.json();
    const memberships = data.data || [];

    // Prüfen ob die E-Mail ein aktives Abo für unser Produkt hat
    const activeMembership = memberships.find(m =>
      m.user?.email?.toLowerCase() === email.toLowerCase() &&
      m.product_id === WHOP_PRODUCT_ID &&
      m.valid === true
    );

    if (!activeMembership) {
      return res.status(403).json({
        error: 'Kein aktives Gastro-OS Abonnement für diese E-Mail gefunden.'
      });
    }

    // Session-Cookie setzen (30 Tage gültig)
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
