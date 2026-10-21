// api/tool-data.js
const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };
}

// ─── Zentrale-Ansicht: Zahlen der zugeordneten Filialen (nur lesen) ──────────
// Nur Zugänge, die in der Tabelle filial_gruppen als zentrale_email eingetragen sind, dürfen das abrufen.
// Es werden nur Zahlen zurückgegeben (keine E-Mail-Adressen, keine Belegdateien).
async function gruppeUebersicht(req, res, email) {
  const von = String(req.query.von || '');
  const bis = String(req.query.bis || '');
  const datumOk = /^\d{4}-\d{2}-\d{2}$/;
  if (!datumOk.test(von) || !datumOk.test(bis) || von > bis) {
    return res.status(400).json({ error: 'Zeitraum ungültig.' });
  }
  if ((new Date(bis) - new Date(von)) / 86400000 > 92) {
    return res.status(400).json({ error: 'Zeitraum zu lang (max. 92 Tage).' });
  }
  try {
    const gRes = await fetch(
      SUPABASE_URL + '/rest/v1/filial_gruppen?zentrale_email=eq.' + encodeURIComponent(email) +
      '&select=filiale_email,filiale_name&order=filiale_name.asc&limit=500',
      { headers: sbHeaders() }
    );
    const filialen = await gRes.json();
    if (!Array.isArray(filialen)) return res.status(500).json({ error: 'Fehler beim Laden.' });
    if (filialen.length === 0) return res.status(403).json({ error: 'Kein Zentrale-Zugang.' });

    const emails = filialen.map(f => '"' + String(f.filiale_email).replace(/"/g, '') + '"').join(',');
    const tools = ['tagesgeschaeft-kassenbuch', 'tagesgeschaeft-stornos', 'tagesgeschaeft-freigetraenke', 'tagesgeschaeft-abschreibungen'];
    const dRes = await fetch(
      SUPABASE_URL + '/rest/v1/user_tool_data?user_id=in.(' + encodeURIComponent(emails) + ')' +
      '&tool_name=in.(' + tools.join(',') + ')&select=user_id,tool_name,data,updated_at&order=updated_at.desc&limit=5000',
      { headers: sbHeaders() }
    );
    const rows = await dRes.json();
    if (!Array.isArray(rows)) return res.status(500).json({ error: 'Fehler beim Laden.' });

    // pro Filiale und Tool nur die neueste Zeile verwenden
    const neueste = {};
    rows.forEach(r => {
      const k = r.user_id + '|' + r.tool_name;
      if (!neueste[k]) neueste[k] = r.data || {};
    });

    const num = v => (typeof v === 'number' && isFinite(v)) ? v : (parseFloat(v) || 0);
    const imZeitraum = d => typeof d === 'string' && d >= von && d <= bis;

    const ergebnis = filialen.map(f => {
      const tage = {};
      const tag = d => (tages => tages[d] || (tages[d] = {
        eintrag: false, kasse: 0, karte: 0, lieferdienste: 0, ueberweisung: 0, umsatz: 0,
        wareneinkauf: 0, sonstiges: 0, stornoAnzahl: 0, stornoSumme: 0,
        freiAnzahl: 0, freiSumme: 0, abschrAnzahl: 0, abschrSumme: 0
      }))(tage);

      const kb = neueste[f.filiale_email + '|tagesgeschaeft-kassenbuch'] || {};
      Object.keys(kb).forEach(d => {
        if (!imZeitraum(d)) return;
        const t = kb[d] || {};
        const x = tag(d);
        x.eintrag = true;
        x.kasse = num(t.kasse); x.karte = num(t.karte);
        x.lieferdienste = num(t.lieferdienste); x.ueberweisung = num(t.ueberweisung);
        x.umsatz = x.kasse + x.karte + x.lieferdienste + x.ueberweisung;
        x.wareneinkauf = num(t.wareneinkaufBar) + num(t.wareneinkaufKarte) + num(t.wareneinkaufUeberweisung);
        x.sonstiges = num(t.sonstigesBar) + num(t.sonstigesKarte) + num(t.sonstigesUeberweisung);
      });

      const liste = (tool) => {
        const d = neueste[f.filiale_email + '|' + tool] || {};
        return Array.isArray(d.items) ? d.items : [];
      };
      liste('tagesgeschaeft-stornos').forEach(i => {
        if (!imZeitraum(i.datum)) return;
        const x = tag(i.datum); x.stornoAnzahl += 1; x.stornoSumme += num(i.betrag);
      });
      liste('tagesgeschaeft-freigetraenke').forEach(i => {
        if (!imZeitraum(i.datum)) return;
        const x = tag(i.datum); x.freiAnzahl += 1; x.freiSumme += num(i.wert);
      });
      liste('tagesgeschaeft-abschreibungen').forEach(i => {
        if (!imZeitraum(i.datum)) return;
        const x = tag(i.datum); x.abschrAnzahl += 1; x.abschrSumme += num(i.wert);
      });

      return { name: f.filiale_name, tage };
    });

    return res.status(200).json({ von, bis, filialen: ergebnis });
  } catch (e) {
    return res.status(500).json({ error: 'Fehler beim Laden.' });
  }
}

export default async function handler(req, res) {
  const email = getEmailFromRequest(req);
  if (!email) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }

  // ─── GET: Zustand laden ───────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (req.query.gruppe === 'uebersicht') return gruppeUebersicht(req, res, email);
    const tool = req.query.tool;
    if (!tool) return res.status(400).json({ error: 'tool fehlt.' });

    try {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(email) +
        '&tool_name=eq.' + encodeURIComponent(tool) + '&select=data&order=updated_at.desc&limit=1',
        { headers: sbHeaders() }
      );
      const rows = await r.json();
      const data = (rows && rows.length > 0 && rows[0].data) ? rows[0].data : {};
      return res.status(200).json({ data });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Laden.' });
    }
  }

  // ─── POST: Zustand speichern ──────────────────────────────────────────────
  // Prüft explizit, ob schon eine Zeile existiert, und aktualisiert genau diese —
  // verlässt sich NICHT auf einen Unique-Constraint in der Datenbank (merge-duplicates
  // erzeugt sonst bei fehlendem Constraint bei jedem Speichern eine neue Zeile).
  if (req.method === 'POST') {
    const { tool, data } = req.body || {};
    if (!tool) return res.status(400).json({ error: 'tool fehlt.' });

    try {
      const existingRes = await fetch(
        SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(email) +
        '&tool_name=eq.' + encodeURIComponent(tool) + '&select=id&order=updated_at.desc',
        { headers: sbHeaders() }
      );
      const existingRows = await existingRes.json();

      if (existingRows && existingRows.length > 0) {
        // Zeile(n) existieren bereits — die neueste gezielt aktualisieren.
        const id = existingRows[0].id;
        await fetch(SUPABASE_URL + '/rest/v1/user_tool_data?id=eq.' + id, {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({
            data: data || {},
            updated_at: new Date().toISOString()
          })
        });

        // Falls durch den alten Bug bereits mehrere Zeilen für diesen Nutzer/Tool existieren,
        // die überzähligen (älteren) Duplikate aufräumen.
        if (existingRows.length > 1) {
          for (let i = 1; i < existingRows.length; i++) {
            await fetch(SUPABASE_URL + '/rest/v1/user_tool_data?id=eq.' + existingRows[i].id, {
              method: 'DELETE',
              headers: sbHeaders()
            });
          }
        }
      } else {
        // Noch keine Zeile — neu anlegen.
        await fetch(SUPABASE_URL + '/rest/v1/user_tool_data', {
          method: 'POST',
          headers: sbHeaders(),
          body: JSON.stringify({
            user_id: email,
            tool_name: tool,
            data: data || {},
            updated_at: new Date().toISOString()
          })
        });
      }
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: 'Fehler beim Speichern.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
