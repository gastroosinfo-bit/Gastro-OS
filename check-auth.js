// api/check-auth.js
const crypto = require('crypto');

const WHOP_API_KEY = process.env.WHOP_API_KEY;
const WHOP_PRODUCT_ID = process.env.WHOP_PRODUCT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;
const BYPASS_EMAILS = process.env.BYPASS_EMAILS || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SESSION_DAYS = 30;

// Zeitlich begrenzte Demo-Zugänge (z.B. für Kooperationspartner)
// expires im Format 'YYYY-MM-DD'
const DEMO_ACCESS = {
  'westerwinter@dehoga-nrw.de': { expires: '2026-08-15' },
  'franz.perner@wkbgld.at': { expires: '2026-08-15' },
  'z.asel@dehogabw.de': { expires: '2026-09-04' },
  'natascha.kummer@wkbgld.at': { expires: '2026-09-02' }
};

function getDemoAccess(email) {
  const entry = DEMO_ACCESS[email.toLowerCase()];
  if (!entry) return null;
  const expiryMs = new Date(entry.expires + 'T23:59:59').getTime();
  if (Date.now() > expiryMs) return null; // abgelaufen
  return { expiryMs };
}

function signSession(email, customExpiryMs) {
  const expires = customExpiryMs || (Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const data = `${email}|${expires}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
  return Buffer.from(`${data}|${sig}`).toString('base64');
}

function hashPassword(password) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(password).digest('hex');
}

async function getProfile(email) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email.toLowerCase())}&select=password_hash`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      }
    }
  );
  if (!response.ok) return null;
  const data = await response.json();
  return data && data.length > 0 ? data[0] : null;
}

// Protokolliert jeden erfolgreichen Login (auch Demo-/Bypass-Zugänge) in der Tabelle login_log.
// Fehler beim Protokollieren dürfen den Login selbst niemals blockieren, daher try/catch ohne throw.
async function logLogin(email) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/login_log`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: email.toLowerCase() }),
    });
  } catch (e) {
    // bewusst stumm — Logging darf den Login nicht gefährden
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password, step } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse' });
  }

  const bypassList = BYPASS_EMAILS.split(',').map(e => e.trim().toLowerCase());
  const isBypass = bypassList.includes(email.toLowerCase());
  const demoAccess = getDemoAccess(email); // null wenn kein Demo-Zugang oder abgelaufen
  const isDemo = !!demoAccess;
  const hasFreeAccess = isBypass || isDemo;

  // SCHRITT: check_email — prüft Whop + ob Passwort bereits gesetzt
  if (step === 'check_email') {

    if (!hasFreeAccess) {
      // Whop-Prüfung
      const membershipRes = await fetch(
        `https://api.whop.com/v5/company/memberships?product_id=${WHOP_PRODUCT_ID}`,
        { headers: { 'Authorization': `Bearer ${WHOP_API_KEY}`, 'Content-Type': 'application/json' } }
      );
      if (!membershipRes.ok) {
        return res.status(500).json({ error: 'Whop API nicht erreichbar' });
      }
      const membershipData = await membershipRes.json();
      const memberships = membershipData.data || [];
      let found = false;
      for (const membership of memberships) {
        const userId = membership.user_id;
        if (!userId) continue;
        const userRes = await fetch(
          `https://api.whop.com/v5/company/users/${userId}`,
          { headers: { 'Authorization': `Bearer ${WHOP_API_KEY}`, 'Content-Type': 'application/json' } }
        );
        if (!userRes.ok) continue;
        const user = await userRes.json();
        if (user.email?.toLowerCase() === email.toLowerCase()) { found = true; break; }
      }
      if (!found) {
        return res.status(403).json({ error: 'Kein aktives Gastro-OS Abonnement für diese E-Mail gefunden.' });
      }
    }

    const profile = await getProfile(email);
    const hasPassword = !!(profile && profile.password_hash);
    return res.status(200).json({ hasPassword });
  }

  // SCHRITT: login — Passwort prüfen + Session setzen
  if (step === 'login') {
    if (!password) {
      return res.status(400).json({ error: 'Passwort fehlt.' });
    }

    if (hasFreeAccess) {
      // Bei Demo-Zugang: Session darf nicht länger laufen als der Demo-Zeitraum
      const customExpiryMs = isDemo ? demoAccess.expiryMs : null;
      const token = signSession(email, customExpiryMs);
      const maxAge = isDemo
        ? Math.floor((demoAccess.expiryMs - Date.now()) / 1000)
        : SESSION_DAYS * 86400;
      res.setHeader('Set-Cookie',
        `gastro_os_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
      );
      await logLogin(email);
      return res.status(200).json({ success: true });
    }

    const profile = await getProfile(email);
    if (!profile || !profile.password_hash) {
      return res.status(403).json({ error: 'Kein Passwort gesetzt. Bitte neu anmelden.' });
    }

    const hash = hashPassword(password);
    if (hash !== profile.password_hash) {
      return res.status(403).json({ error: 'Falsches Passwort. Bitte versuche es erneut.' });
    }

    const token = signSession(email);
    res.setHeader('Set-Cookie',
      `gastro_os_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
    );
    await logLogin(email);
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: 'Ungültiger Schritt.' });
}
