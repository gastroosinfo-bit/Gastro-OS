// api/beleg-upload.js
// Upload und signierter Abruf von Beleg-Dateien (PDF oder Foto) über Supabase Storage.
// Automatische Auslese: PDFs werden per Text-Extraktion (pdf-parse, kostenlos) ausgelesen,
// Fotos werden per Claude/Anthropic-Bilderkennung ausgelesen (kostenpflichtig, ANTHROPIC_API_KEY).
// Nutzt denselben Session-Cookie-Auth-Mechanismus wie api/tool-data.js.

const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BUCKET = 'belege';

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
  } catch (e) {
    return null;
  }
}

function getEmailFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/gastro_os_session=([^;]+)/);
  if (!match) return null;
  return verifySession(decodeURIComponent(match[1]));
}

function safeFileName(name) {
  return String(name || 'beleg.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
}

// ─── Automatische Auslese aus PDF-Text (kostenlos) ───────────────────────
function belegDatumFinden(text) {
  const match = text.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/);
  if (!match) return null;
  let [, tag, monat, jahr] = match;
  if (jahr.length === 2) jahr = '20' + jahr;
  const jahrNum = parseInt(jahr, 10);
  if (jahrNum < 2015 || jahrNum > 2035) return null;
  tag = tag.padStart(2, '0');
  monat = monat.padStart(2, '0');
  return `${jahr}-${monat}-${tag}`;
}
function belegBetragFinden(text) {
  const keywordMatch = text.match(/(Gesamtbetrag|Gesamtsumme|Rechnungsbetrag|Endbetrag|Zu\s*zahlen|Gesamt)[^\d]{0,25}(\d{1,4}[.,]\d{2})/i);
  if (keywordMatch) return parseFloat(keywordMatch[2].replace(',', '.'));
  const alle = [...text.matchAll(/(\d{1,4})[,.](\d{2})(?!\d)/g)].map(m => parseFloat(m[1] + '.' + m[2]));
  if (alle.length) return Math.max(...alle);
  return null;
}
function belegPlattformFinden(text) {
  const bekannte = ['Lieferando', 'Wolt', 'Uber Eats', 'Metro'];
  const lower = text.toLowerCase();
  for (const name of bekannte) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  return null;
}
function belegMwstFinden(text) {
  const m19 = text.match(/(19\s*%[^\d]{0,20}|MwSt\.?\s*19\s*%[^\d]{0,20})(\d{1,4}[,.]\d{2})/i);
  const m7 = text.match(/(7\s*%[^\d]{0,20}|MwSt\.?\s*7\s*%[^\d]{0,20})(\d{1,4}[,.]\d{2})/i);
  return {
    mwst19Betrag: m19 ? parseFloat(m19[2].replace(',', '.')) : null,
    mwst7Betrag: m7 ? parseFloat(m7[2].replace(',', '.')) : null
  };
}
function belegRechnungsnrFinden(text) {
  const match = text.match(/(Rechnungs-?(?:nr|nummer)|Liefer(?:schein)?-?(?:nr|nummer))[.:\s]{0,5}([A-Za-z0-9\-\/]{3,20})/i);
  return match ? match[2] : null;
}

async function belegAuslesenPdf(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    const text = data.text || '';
    const mwst = belegMwstFinden(text);
    return {
      datum: belegDatumFinden(text),
      betrag: belegBetragFinden(text),
      plattform: belegPlattformFinden(text),
      mwst19Betrag: mwst.mwst19Betrag,
      mwst7Betrag: mwst.mwst7Betrag,
      rechnungsnummer: belegRechnungsnrFinden(text)
    };
  } catch (e) {
    return { datum: null, betrag: null, plattform: null, mwst19Betrag: null, mwst7Betrag: null, rechnungsnummer: null };
  }
}

// ─── Automatische Auslese aus Fotos via Claude/Anthropic (kostenpflichtig) ──
// ─── Automatische Auslese via Claude/Anthropic (Fotos UND PDFs ohne Textschicht) ──
async function belegAuslesenClaude(buffer, contentType) {
  if (!ANTHROPIC_API_KEY) {
    return { datum: null, betrag: null, plattform: null, mwst19Betrag: null, mwst7Betrag: null, rechnungsnummer: null };
  }
  try {
    const base64 = buffer.toString('base64');
    const istPdf = contentType === 'application/pdf';
    const contentBlock = istPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: contentType || 'image/jpeg', data: base64 } };
    const prompt = 'Das ist eine Rechnung oder ein Kassenbon aus der Gastronomie oder einem Einzelhandel/Großhandel (z. B. Lidl, Metro, Medimax). ' +
      'Lies daraus folgende Angaben aus und antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne weiteren Text, ohne Markdown-Codeblock: ' +
      '{"datum": "YYYY-MM-DD oder null", "betrag": Zahl (Gesamt-Bruttobetrag) oder null, "plattform": "Name des Lieferanten/Geschäfts oder null", ' +
      '"mwst19Betrag": Zahl (nur der MwSt-Betrag bei 19%, falls auf dem Beleg separat ausgewiesen, sonst null) oder null, ' +
      '"mwst7Betrag": Zahl (nur der MwSt-Betrag bei 7%, falls auf dem Beleg separat ausgewiesen, sonst null) oder null, ' +
      '"rechnungsnummer": "Rechnungs-, Beleg- oder Liefernummer oder null"}. ' +
      'Viele Kassenbons weisen BEIDE MwSt-Sätze getrennt aus — trag dann beide Werte ein. ' +
      'Falls ein Wert nicht eindeutig erkennbar ist, setze null statt zu raten.';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
      })
    });

    if (!res.ok) {
      return { datum: null, betrag: null, plattform: null, mwst19Betrag: null, mwst7Betrag: null, rechnungsnummer: null };
    }
    const data = await res.json();
    const textAntwort = (data.content && data.content[0] && data.content[0].text) || '';
    const bereinigt = textAntwort.replace(/```json|```/g, '').trim();
    const geparst = JSON.parse(bereinigt);
    return {
      datum: geparst.datum || null,
      betrag: (typeof geparst.betrag === 'number') ? geparst.betrag : null,
      plattform: geparst.plattform || null,
      mwst19Betrag: (typeof geparst.mwst19Betrag === 'number') ? geparst.mwst19Betrag : null,
      mwst7Betrag: (typeof geparst.mwst7Betrag === 'number') ? geparst.mwst7Betrag : null,
      rechnungsnummer: geparst.rechnungsnummer || null
    };
  } catch (e) {
    return { datum: null, betrag: null, plattform: null, mwst19Betrag: null, mwst7Betrag: null, rechnungsnummer: null };
  }
}

function belegErgebnisLeer(erg) {
  return !erg.datum && erg.betrag == null && !erg.plattform && erg.mwst19Betrag == null && erg.mwst7Betrag == null && !erg.rechnungsnummer;
}

async function belegAuslesen(buffer, contentType) {
  if (contentType === 'application/pdf') {
    const perText = await belegAuslesenPdf(buffer);
    // Kein Text gefunden (z. B. eingescannte PDF) — zusätzlich über Claude versuchen.
    if (belegErgebnisLeer(perText)) {
      return belegAuslesenClaude(buffer, contentType);
    }
    return perText;
  }
  if (contentType && contentType.startsWith('image/')) {
    return belegAuslesenClaude(buffer, contentType);
  }
  return { datum: null, betrag: null, plattform: null, mwst19Betrag: null, mwst7Betrag: null, rechnungsnummer: null };
}

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };
}

export default async function handler(req, res) {
  const email = getEmailFromRequest(req);
  if (!email) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }

  // ─── POST: Datei hochladen (oder nur analysieren) ──────────────────────
  if (req.method === 'POST') {
    const { filename, contentBase64, contentType, analyzeOnly } = req.body || {};
    if (!contentBase64) {
      return res.status(400).json({ error: 'contentBase64 fehlt.' });
    }

    let buffer;
    try {
      buffer = Buffer.from(contentBase64, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Ungültige Datei.' });
    }
    if (buffer.length > 8 * 1024 * 1024) {
      return res.status(413).json({ error: 'Datei zu groß (max. 8 MB).' });
    }

    if (analyzeOnly) {
      const extracted = await belegAuslesen(buffer, contentType);
      return res.status(200).json({ extracted });
    }

    if (!filename) {
      return res.status(400).json({ error: 'filename fehlt.' });
    }

    try {
      const path = `${encodeURIComponent(email)}/${Date.now()}-${safeFileName(filename)}`;
      const uploadRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
        {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
            'Content-Type': contentType || 'application/pdf'
          },
          body: buffer
        }
      );
      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        return res.status(502).json({ error: 'Upload fehlgeschlagen.', detail: errText });
      }
      const extracted = await belegAuslesen(buffer, contentType);
      return res.status(200).json({ path, extracted });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Hochladen.' });
    }
  }

  // ─── GET: Signierte URL zum Anzeigen/Herunterladen erzeugen ────────────
  if (req.method === 'GET') {
    const path = req.query.path;
    if (!path) return res.status(400).json({ error: 'path fehlt.' });
    if (!path.startsWith(encodeURIComponent(email) + '/')) {
      return res.status(403).json({ error: 'Kein Zugriff.' });
    }
    try {
      const signRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`,
        {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ expiresIn: 3600 })
        }
      );
      const signData = await signRes.json();
      if (!signRes.ok || !signData.signedURL) {
        return res.status(502).json({ error: 'Signierte URL konnte nicht erstellt werden.' });
      }
      return res.status(200).json({ url: SUPABASE_URL + '/storage/v1' + signData.signedURL });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Abrufen.' });
    }
  }

  // ─── DELETE: Datei löschen ──────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { path } = req.body || {};
    if (!path) return res.status(400).json({ error: 'path fehlt.' });
    if (!path.startsWith(encodeURIComponent(email) + '/')) {
      return res.status(403).json({ error: 'Kein Zugriff.' });
    }
    try {
      await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
        }
      });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Löschen.' });
    }
  }

  return res.status(405).json({ error: 'Methode nicht erlaubt.' });
}
