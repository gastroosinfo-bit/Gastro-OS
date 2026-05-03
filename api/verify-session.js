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

export default function handler(req, res) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/gastro_os_session=([^;]+)/);
  if (!match) return res.status(401).json({ valid: false });

  const email = verifySession(decodeURIComponent(match[1]));
  if (!email) return res.status(401).json({ valid: false });

  return res.status(200).json({ valid: true, email });
}
