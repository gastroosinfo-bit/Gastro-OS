const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(normalizedEmail)}&select=email`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      }
    }
  );
  const profiles = await profileRes.json();

  if (!profiles || profiles.length === 0) {
    return res.status(200).json({ success: true });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await fetch(`${SUPABASE_URL}/rest/v1/password_resets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ email: normalizedEmail, token, expires_at: expiresAt })
  });

  const resetLink = `https://www.mein-gastro-system.de/reset-password.html?token=${token}&email=${encodeURIComponent(normalizedEmail)}`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'noreply@mein-gastro-system.de',
      to: normalizedEmail,
      subject: 'Gastro-OS · Passwort zurücksetzen',
      html: `
        <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; background: #F5F0E8;">
          <div style="background: #fff; border: 1px solid #D4AF37; border-radius: 8px; padding: 40px;">
            <h1 style="font-size: 28px; color: #1A2A4A; margin-bottom: 4px;">Gastro<span style="color:#D4AF37;">-OS</span></h1>
            <p style="font-size: 11px; letter-spacing: 4px; color: #9A7D3A; margin-bottom: 32px;">SYSTEM · STRATEGIE · ERFOLG</p>
            <h2 style="font-size: 18px; color: #1A2A4A; margin-bottom: 16px;">Passwort zurücksetzen</h2>
            <p style="color: #444; font-size: 14px; line-height: 1.7; margin-bottom: 28px;">
              Du hast eine Anfrage zum Zurücksetzen deines Passworts gestellt. Klicke auf den Button um ein neues Passwort festzulegen. Der Link ist 1 Stunde gültig.
            </p>
            <a href="${resetLink}" style="display:inline-block; background:#1A2A4A; color:#D4AF37; padding:14px 28px; border-radius:4px; text-decoration:none; font-weight:700; letter-spacing:2px; font-size:14px;">PASSWORT ZURÜCKSETZEN</a>
            <p style="margin-top: 28px; color: #999; font-size: 12px; line-height: 1.6;">
              Falls du keine Anfrage gestellt hast, kannst du diese Mail ignorieren.<br/>
              Bitte antworte nicht auf diese E-Mail.
            </p>
          </div>
        </div>
      `
    })
  });

  return res.status(200).json({ success: true });
}
