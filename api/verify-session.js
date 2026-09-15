// api/verify-session.js
const crypto = require('crypto');
const SESSION_SECRET = process.env.SESSION_SECRET;

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
  } catch(e) {
    return null;
  }
}

// Zeitlich befristete Zugänge (z. B. kostenlose Testzugänge): ab dem
// hinterlegten Datum (inklusive) gilt die Sitzung als ungültig — greift
// zentral hier, also auf jeder Seite, die /api/verify-session nutzt.
const BEFRISTETE_ZUGAENGE = {
  'koslowski@progres.de': '2026-09-22',
  'z.asel@dehogabw.de': '2026-09-15',
  'natascha.kummer@wkbgld.at': '2026-09-15',
  'westerwinter@dehoga-nrw.de': '2026-09-15',
  'franz.perner@wkbgld.at': '2026-09-15',
  'info@gastronomen.koeln': '2026-09-16'
};

function heutigesDatumString() {
  const d = new Date();
  const j = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const t = String(d.getDate()).padStart(2, '0');
  return `${j}-${m}-${t}`;
}

export default function handler(req, res) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/gastro_os_session=([^;]+)/);
  if (!match) return res.status(401).json({ valid: false });

  const email = verifySession(decodeURIComponent(match[1]));
  if (!email) return res.status(401).json({ valid: false });

  const ablaufDatum = BEFRISTETE_ZUGAENGE[email.toLowerCase()];
  if (ablaufDatum && heutigesDatumString() >= ablaufDatum) {
    return res.status(401).json({ valid: false, zugangAbgelaufen: true });
  }

  return res.status(200).json({ valid: true, email });
}
