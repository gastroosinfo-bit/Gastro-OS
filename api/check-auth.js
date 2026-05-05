
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

  // Whitelist-Check
  const bypassList = BYPASS_EMAILS.split(',').map(e => e.trim().toLowerCase());
  if (bypassList.includes(email.toLowerCase())) {
    const token = signSession(email);
    res.setHeader('Set-Cookie',
      `gastro_os_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
    );
    return res.status(200).json({ success: true });
  }

  try {
    // Schritt 1: Aktive Memberships für unser Produkt holen
    const membershipRes = await fetch(
      `https://api.whop.com/v5/app/memberships?product_id=${WHOP_PRODUCT_ID}&valid=true`,
      {
        headers: {
          'Authorization': `Bearer ${WHOP_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!membershipRes.ok) {
      const errText = await membershipRes.text();
      console.error('Whop Memberships Fehler:', membershipRes.status, errText);
      return res.status(500).json({ error: 'Whop API nicht erreichbar' });
    }

    const membershipData = await membershipRes.json();
    const memberships = membershipData.data || [];

    // Schritt 2: Für jede Membership den User holen und E-Mail prüfen
    let found = false;
    for (const membership of memberships) {
      const userId = membership.user_id;
      if (!userId) continue;

      const userRes = await fetch(
        `https://api.whop.com/v5/app/users/${userId}`,
        {
          headers: {
            'Authorization': `Bearer ${WHOP_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!userRes.ok) continue;

      const user = await userRes.json();
      if (user.email?.toLowerCase() === email.toLowerCase()) {
        found = true;
        break;
      }
    }

    if (!found) {
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
