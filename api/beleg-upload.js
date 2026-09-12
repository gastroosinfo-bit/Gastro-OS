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

// Sonderzeichen wie "@" führten bei Supabase Storage zu ungültigen Signaturen
// bei signierten URLs — deshalb wird der Ordnername pro Nutzer jetzt bereinigt,
// statt die E-Mail nur URL-zu-encodieren.
function safeUserFolder(email) {
  return String(email || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
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
function belegIstZBon(text) {
  return /(Z-?BON|TAGESABSCHLUSS|KASSENABSCHLUSS)/i.test(text);
}
function belegBarKarteFinden(text) {
  const bar = text.match(/(Bar)[^\d]{0,15}(\d{1,4}[,.]\d{2})/i);
  const karte = text.match(/(Karte|Kartenzahlung|EC-?Karte)[^\d]{0,15}(\d{1,4}[,.]\d{2})/i);
  return {
    barBetrag: bar ? parseFloat(bar[2].replace(',', '.')) : null,
    kartenBetrag: karte ? parseFloat(karte[2].replace(',', '.')) : null
  };
}

async function belegAuslesenPdf(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    const text = data.text || '';
    const mwst = belegMwstFinden(text);
    const barKarte = belegBarKarteFinden(text);
    return {
      datum: belegDatumFinden(text),
      betrag: belegBetragFinden(text),
      plattform: belegPlattformFinden(text),
      mwst19Betrag: mwst.mwst19Betrag,
      mwst7Betrag: mwst.mwst7Betrag,
      istZBon: belegIstZBon(text),
      barBetrag: barKarte.barBetrag,
      kartenBetrag: barKarte.kartenBetrag,
      rechnungsnummer: belegRechnungsnrFinden(text)
    };
  } catch (e) {
    return { datum: null, betrag: null, plattform: null, mwst19Betrag: null, mwst7Betrag: null, istZBon: false, barBetrag: null, kartenBetrag: null, rechnungsnummer: null };
  }
}

// ─── Automatische Auslese aus Fotos via Claude/Anthropic (kostenpflichtig) ──
// ─── Automatische Auslese via Claude/Anthropic (Fotos UND PDFs ohne Textschicht) ──
async function belegAuslesenClaude(buffer, contentType) {
  if (!ANTHROPIC_API_KEY) {
    return { datum: null, betrag: null, plattform: null, mwst19Betrag: null, mwst7Betrag: null, istZBon: false, barBetrag: null, kartenBetrag: null, rechnungsnummer: null };
  }
  try {
    const base64 = buffer.toString('base64');
    const istPdf = contentType === 'application/pdf';
    const contentBlock = istPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: contentType || 'image/jpeg', data: base64 } };
    const prompt = 'Das ist eine Rechnung, ein Kassenbon oder ein Kassen-Tagesabschluss (Z-Bon) aus der Gastronomie oder einem Einzelhandel/Großhandel (z. B. Lidl, Metro, Medimax). ' +
      'Lies daraus folgende Angaben aus und antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne weiteren Text, ohne Markdown-Codeblock: ' +
      '{"datum": "YYYY-MM-DD oder null", "betrag": Zahl (Gesamt-Bruttobetrag bzw. Gesamtumsatz) oder null, "plattform": "Name des Lieferanten/Geschäfts oder null", ' +
      '"mwst19Betrag": Zahl (nur der MwSt-Betrag bei 19%, falls auf dem Beleg separat ausgewiesen, sonst null) oder null, ' +
      '"mwst7Betrag": Zahl (nur der MwSt-Betrag bei 7%, falls auf dem Beleg separat ausgewiesen, sonst null) oder null, ' +
      '"istZBon": true oder false (true nur, wenn es sich klar um einen Kassen-Tagesabschluss/Z-Bon handelt, erkennbar an Begriffen wie "Z-Bon", "Tagesabschluss" oder "Kassenabschluss"), ' +
      '"barBetrag": Zahl (Bar-Anteil des Umsatzes, nur bei Z-Bons relevant) oder null, ' +
      '"kartenBetrag": Zahl (Kartenzahlungs-Anteil des Umsatzes, nur bei Z-Bons relevant) oder null, ' +
      '"rechnungsnummer": "Rechnungs-, Beleg-, Liefer- oder Bon-Nummer oder null"}. ' +
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
      return { datum: null, betrag: null, plattform: null, mwst19Betrag: null, mwst7Betrag: null, istZBon: false, barBetrag: null, kartenBetrag: null, rechnungsnummer: null };
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
      istZBon: geparst.istZBon === true,
      barBetrag: (typeof geparst.barBetrag === 'number') ? geparst.barBetrag : null,
      kartenBetrag: (typeof geparst.kartenBetrag === 'number') ? geparst.kartenBetrag : null,
      rechnungsnummer: geparst.rechnungsnummer || null
    };
  } catch (e) {
    return { datum: null, betrag: null, plattform: null, mwst19Betrag: null, mwst7Betrag: null, istZBon: false, barBetrag: null, kartenBetrag: null, rechnungsnummer: null };
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

// ─── Artikelbericht: Gericht + verkaufte Menge auslesen (immer via Claude) ──
async function artikelberichtAuslesen(buffer, contentType) {
  if (!ANTHROPIC_API_KEY) {
    return { artikel: [] };
  }
  try {
    const base64 = buffer.toString('base64');
    const istPdf = contentType === 'application/pdf';
    const contentBlock = istPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: contentType || 'image/jpeg', data: base64 } };
    const prompt = 'Das ist ein Artikel- bzw. Verkaufsbericht aus einem Kassensystem einer Gastronomie. Er zeigt, welche Gerichte/Artikel wie oft verkauft wurden. ' +
      'Lies JEDE Zeile mit einem Gericht/Artikel und der dazugehörigen verkauften Menge (Anzahl) aus. ' +
      'Ordne jeden Artikel zusätzlich einer Kategorie zu: "speise" für Essen, "getraenk" für alle Getränke (auch alkoholische). ' +
      'Falls auf dem Bericht erkennbar ist, über welchen Kanal verkauft wurde (z. B. "Vor Ort", "Abholung"/"Take-away", "Lieferung"/"Delivery"), trage das als "kanal" ein — steht sowas NICHT auf dem Bericht, setze "kanal" auf null, rate NICHT. ' +
      'Antworte AUSSCHLIESSLICH mit einem JSON-Array, ohne weiteren Text, ohne Markdown-Codeblock, in genau diesem Format: ' +
      '[{"gericht":"Name des Gerichts","menge": Zahl, "kategorie":"speise" oder "getraenk", "kanal":"Vor Ort/Abholung/Lieferung oder null"}]. ' +
      'Überspringe Kopfzeilen, Summen-/Gesamtzeilen und Spaltentitel — nur echte Artikel-Zeilen mit Name und Menge. ' +
      'Falls die Menge bei einer Zeile nicht eindeutig lesbar ist, überspringe diese Zeile lieber, als zu raten.';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
      })
    });

    if (!res.ok) return { artikel: [] };
    const data = await res.json();
    const textAntwort = (data.content && data.content[0] && data.content[0].text) || '';
    const bereinigt = textAntwort.replace(/```json|```/g, '').trim();
    const geparst = JSON.parse(bereinigt);
    if (!Array.isArray(geparst)) return { artikel: [] };
    const artikel = geparst
      .filter(a => a && typeof a.gericht === 'string' && a.gericht.trim() && typeof a.menge === 'number')
      .map(a => ({
        gericht: a.gericht.trim(),
        menge: a.menge,
        kategorie: a.kategorie === 'getraenk' ? 'getraenk' : 'speise',
        kanal: (typeof a.kanal === 'string' && a.kanal.trim()) ? a.kanal.trim() : null
      }));
    return { artikel };
  } catch (e) {
    return { artikel: [] };
  }
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

  // ─── PATCH: Einmalige Reparatur alter Beleg-Pfade (Sonderzeichen-Problem) ──
  // Verschiebt Dateien serverseitig vom alten (fehleranfälligen) Pfad-Format
  // auf das neue, sichere Format und aktualisiert die gespeicherten Pfade —
  // ohne dass Dateien neu hochgeladen werden müssen.
  // Gibt zusätzlich Debug-Infos zurück, damit sichtbar wird, welches Pfad-
  // Format tatsächlich gespeichert ist, falls nichts erkannt/repariert wird.
  if (req.method === 'PATCH') {
    const altesPraefix = encodeURIComponent(email) + '/';
    try {
      const dataRes = await fetch(
        SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(email) +
        '&tool_name=eq.tagesgeschaeft-belege&select=id,data&order=updated_at.desc&limit=1',
        { headers: sbHeaders() }
      );
      const rows = await dataRes.json();
      if (!rows || rows.length === 0) {
        return res.status(200).json({
          repariert: 0,
          gesamt: 0,
          debugAltesPraefix: altesPraefix,
          debugErstePfade: [],
          debugHinweis: 'Keine Zeile in user_tool_data für diesen Nutzer/Tool gefunden.'
        });
      }
      const row = rows[0];
      const items = (row.data && row.data.items) || [];
      const neuesPraefix = safeUserFolder(email) + '/';

      let repariert = 0;
      let gefundeneKandidaten = 0;
      const debugVersuche = [];
      for (const item of items) {
        if (!item.storagePath || !item.storagePath.startsWith(altesPraefix)) continue;
        gefundeneKandidaten++;
        const restPfad = item.storagePath.slice(altesPraefix.length);
        const neuerPfad = neuesPraefix + restPfad;
        // Der eigentliche Objekt-Schlüssel in Supabase Storage wurde beim alten
        // Upload-Code mit dem rohen (unenkodierten) E-Mail-String gebildet — die
        // Browser/Fetch-URL hat %40 dabei automatisch wieder zu @ dekodiert.
        // Der in der Datenbank gespeicherte Pfad (mit %40) stimmt daher NICHT
        // mit dem echten Speicherort überein. Wir versuchen zuerst den echten,
        // rohen Pfad (mit @) und fallen nur zur Sicherheit auf den
        // gespeicherten Pfad zurück, falls der erste Versuch fehlschlägt.
        const roherQuellPfad = email + '/' + restPfad;
        const kandidaten = [roherQuellPfad, item.storagePath];
        let erfolgreich = false;
        for (const quelle of kandidaten) {
          try {
            const moveRes = await fetch(SUPABASE_URL + '/storage/v1/object/move', {
              method: 'POST',
              headers: sbHeaders(),
              body: JSON.stringify({ bucketId: BUCKET, sourceKey: quelle, destinationKey: neuerPfad })
            });
            const moveAntwortText = await moveRes.text();
            if (debugVersuche.length < 8) {
              debugVersuche.push({ von: quelle, nach: neuerPfad, status: moveRes.status, ok: moveRes.ok, antwort: moveAntwortText });
            }
            if (moveRes.ok) {
              item.storagePath = neuerPfad;
              repariert++;
              erfolgreich = true;
              break;
            }
          } catch (e) {
            if (debugVersuche.length < 8) {
              debugVersuche.push({ von: quelle, nach: neuerPfad, fehler: String((e && e.message) || e) });
            }
          }
        }
      }

      if (repariert > 0) {
        await fetch(SUPABASE_URL + '/rest/v1/user_tool_data?id=eq.' + row.id, {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({ data: { items }, updated_at: new Date().toISOString() })
        });
      }
      return res.status(200).json({
        repariert,
        gesamt: items.length,
        debugAltesPraefix: altesPraefix,
        debugErstePfade: items.slice(0, 5).map(i => i.storagePath || '(kein storagePath)'),
        debugGefundeneKandidaten: gefundeneKandidaten,
        debugVersuche
      });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler bei der Reparatur.', debugFehler: String((e && e.message) || e) });
    }
  }

  // ─── POST: Datei hochladen (oder nur analysieren) ──────────────────────
  if (req.method === 'POST') {
    const { filename, contentBase64, contentType, analyzeOnly, zweck } = req.body || {};
    if (!contentBase64) {
      return res.status(400).json({ error: 'contentBase64 fehlt.' });
    }

    let buffer;
    try {
      buffer = Buffer.from(contentBase64, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Ungültige Datei.' });
    }
    // Vercel begrenzt den gesamten Request-Body auf ca. 4,5 MB — durch die
    // Base64-Kodierung wird eine Datei beim Hochladen ca. 33% größer, daher
    // hier bewusst deutlich niedriger ansetzen, damit die Anfrage sicher
    // durchkommt (statt von Vercel mit 413 abgewiesen zu werden).
    if (buffer.length > 3 * 1024 * 1024) {
      return res.status(413).json({ error: 'Datei zu groß (max. 3 MB, wegen Vercel-Upload-Grenze).' });
    }

    // ── Speisekarte: mehrere Dateien möglich (z. B. mehrseitige Karte) ───
    // Zeitstempel-Pfad wie bei den Belegen — neue Uploads ersetzen NICHT
    // automatisch alte, damit mehrseitige Speisekarten und Versionswechsel
    // nicht versehentlich verloren gehen. Löschen erfolgt bewusst manuell
    // über den bestehenden DELETE-Endpunkt.
    if (zweck === 'speisekarte') {
      if (!filename) {
        return res.status(400).json({ error: 'filename fehlt.' });
      }
      try {
        const path = `${safeUserFolder(email)}/speisekarte-${Date.now()}-${safeFileName(filename)}`;
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
        return res.status(200).json({ path });
      } catch (e) {
        return res.status(500).json({ error: 'Fehler beim Hochladen der Speisekarte.', detail: String((e && e.message) || e) });
      }
    }

    // ── Artikelbericht: Gericht+Menge auslesen, danach Datei wie gewohnt ──
    // ablegen (Zeitstempel-Pfad, mehrere Berichte bleiben nebeneinander
    // erhalten — anders als bei der Speisekarte).
    if (zweck === 'artikelbericht') {
      if (analyzeOnly) {
        const ergebnis = await artikelberichtAuslesen(buffer, contentType);
        return res.status(200).json(ergebnis);
      }
      if (!filename) {
        return res.status(400).json({ error: 'filename fehlt.' });
      }
      try {
        const path = `${safeUserFolder(email)}/${Date.now()}-${safeFileName(filename)}`;
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
        return res.status(200).json({ path });
      } catch (e) {
        return res.status(500).json({ error: 'Fehler beim Hochladen des Artikelberichts.', detail: String((e && e.message) || e) });
      }
    }

    if (analyzeOnly) {
      const extracted = await belegAuslesen(buffer, contentType);
      return res.status(200).json({ extracted });
    }

    if (!filename) {
      return res.status(400).json({ error: 'filename fehlt.' });
    }

    try {
      const path = `${safeUserFolder(email)}/${Date.now()}-${safeFileName(filename)}`;
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
    if (!path.startsWith(safeUserFolder(email) + '/') && !path.startsWith(encodeURIComponent(email) + '/')) {
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
    if (!path.startsWith(safeUserFolder(email) + '/') && !path.startsWith(encodeURIComponent(email) + '/')) {
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
