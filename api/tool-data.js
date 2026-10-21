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
// ─── Hilfsfunktionen Zentrale / Filialen ─────────────────────────────────────
const WOCHENTAGE = ['mo', 'di', 'mi', 'do', 'fr', 'sa', 'so'];
function ruhetageNormal(v) {
  const liste = Array.isArray(v) ? v : String(v || '').toLowerCase().split(/[\s,;]+/);
  const out = [];
  liste.forEach(x => {
    const k = String(x || '').toLowerCase().slice(0, 2);
    if (WOCHENTAGE.includes(k) && !out.includes(k)) out.push(k);
  });
  return out.join(',');
}
function emailOk(e) { return typeof e === 'string' && e.length <= 160 && /^[^\s@,"'()]+@[^\s@,"'()]+\.[^\s@,"'()]+$/.test(e); }
function q(v) { return encodeURIComponent(v); }

// Stufe/Plan der Zentrale (Tabelle zentrale_plaene); null = keine Zentrale
async function zentralePlan(email) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/zentrale_plaene?zentrale_email=eq.' + q(email.toLowerCase()) + '&select=max_filialen,plan,nur_zentrale&limit=1',
    { headers: sbHeaders() }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}
async function zentraleFilialen(email) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/filial_gruppen?zentrale_email=eq.' + q(email.toLowerCase()) +
    '&status=neq.getrennt&select=filiale_email,filiale_name,ruhetage,status&order=filiale_name.asc&limit=500',
    { headers: sbHeaders() }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) ? rows : null;
}

// Leichte Abfrage: Ist dieser Zugang eine Zentrale? (für Kachel im Dashboard, Überblick und Login-Weiche)
async function gruppeCheck(req, res, email) {
  try {
    const plan = await zentralePlan(email);
    const filialen = await zentraleFilialen(email);
    const ok = !!plan || (Array.isArray(filialen) && filialen.length > 0);
    return res.status(200).json({ zentrale: ok, nurZentrale: !!(plan && plan.nur_zentrale === true) });
  } catch (e) {
    return res.status(200).json({ zentrale: false, nurZentrale: false });
  }
}

// Zentrale: eigene Filialen mit Status und Limit
async function gruppeVerwalten(req, res, email) {
  try {
    const plan = await zentralePlan(email);
    const filialen = await zentraleFilialen(email);
    if (!plan && !(filialen && filialen.length > 0)) return res.status(403).json({ error: 'Kein Zentrale-Zugang.' });
    return res.status(200).json({
      max: plan ? plan.max_filialen : 0,
      plan: plan ? plan.plan : null,
      filialen: (filialen || []).map(f => ({ email: f.filiale_email, name: f.filiale_name, ruhetage: f.ruhetage || '', status: f.status || 'aktiv' }))
    });
  } catch (e) {
    return res.status(500).json({ error: 'Fehler beim Laden.' });
  }
}

// Filiale: Anfragen von Zentralen und bestehende Freigaben
async function gruppeAnfragen(req, res, email) {
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/filial_gruppen?filiale_email=eq.' + q(email.toLowerCase()) +
      '&select=zentrale_email,status&limit=100',
      { headers: sbHeaders() }
    );
    const rows = await r.json();
    if (!Array.isArray(rows)) return res.status(200).json({ anfragen: [], freigaben: [], getrennt: [] });
    // Eigene Zeile (Zentrale = Filiale) nicht anzeigen
    const fremd = rows.filter(x => String(x.zentrale_email).toLowerCase() !== email.toLowerCase());
    return res.status(200).json({
      anfragen: fremd.filter(x => x.status === 'angefragt').map(x => ({ zentrale: x.zentrale_email })),
      freigaben: fremd.filter(x => (x.status || 'aktiv') === 'aktiv').map(x => ({ zentrale: x.zentrale_email })),
      getrennt: fremd.filter(x => x.status === 'getrennt').map(x => ({ zentrale: x.zentrale_email }))
    });
  } catch (e) {
    return res.status(200).json({ anfragen: [], freigaben: [], getrennt: [] });
  }
}

// POST-Aktionen für Zentrale und Filiale
async function gruppeAktion(req, res, email) {
  const b = req.body || {};
  const ich = email.toLowerCase();
  try {
    // ── Filiale antwortet auf eine Anfrage / beendet eine Freigabe
    if (b.gruppe === 'antwort') {
      const zentrale = String(b.zentrale || '').toLowerCase();
      if (!emailOk(zentrale)) return res.status(400).json({ error: 'Angaben ungültig.' });
      const filter = '?zentrale_email=eq.' + q(zentrale) + '&filiale_email=eq.' + q(ich);
      if (b.entscheidung === 'zulassen') {
        await fetch(SUPABASE_URL + '/rest/v1/filial_gruppen' + filter + '&status=eq.angefragt', {
          method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ status: 'aktiv' })
        });
      } else if (b.entscheidung === 'quittieren') {
        await fetch(SUPABASE_URL + '/rest/v1/filial_gruppen' + filter + '&status=eq.getrennt', { method: 'DELETE', headers: sbHeaders() });
      } else if (b.entscheidung === 'ablehnen' || b.entscheidung === 'trennen') {
        await fetch(SUPABASE_URL + '/rest/v1/filial_gruppen' + filter, { method: 'DELETE', headers: sbHeaders() });
      } else {
        return res.status(400).json({ error: 'Angaben ungültig.' });
      }
      return res.status(200).json({ success: true });
    }

    // ── ab hier: nur Zentralen
    const plan = await zentralePlan(ich);
    const bestehende = await zentraleFilialen(ich);
    if (!plan && !(bestehende && bestehende.length > 0)) return res.status(403).json({ error: 'Kein Zentrale-Zugang.' });
    const filiale = String(b.filiale_email || '').toLowerCase().trim();
    if (!emailOk(filiale)) return res.status(400).json({ error: 'Bitte eine gültige E-Mail-Adresse der Filiale eingeben.' });
    const filter = '?zentrale_email=eq.' + q(ich) + '&filiale_email=eq.' + q(filiale);

    if (b.gruppe === 'hinzufuegen') {
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'Bitte einen Namen für die Filiale eingeben.' });
      const max = plan ? plan.max_filialen : 0;
      if ((bestehende || []).length >= max) {
        return res.status(403).json({ error: 'limit', max, belegt: (bestehende || []).length });
      }
      if ((bestehende || []).some(f => String(f.filiale_email).toLowerCase() === filiale)) {
        return res.status(409).json({ error: 'Diese E-Mail-Adresse ist schon eingetragen.' });
      }
      await fetch(SUPABASE_URL + '/rest/v1/filial_gruppen' + filter + '&status=eq.getrennt', { method: 'DELETE', headers: sbHeaders() });
      const ins = await fetch(SUPABASE_URL + '/rest/v1/filial_gruppen', {
        method: 'POST', headers: sbHeaders(),
        body: JSON.stringify({
          zentrale_email: ich, filiale_email: filiale, filiale_name: name,
          ruhetage: ruhetageNormal(b.ruhetage),
          status: filiale === ich ? 'aktiv' : 'angefragt'   // eigene Adresse braucht keine Zustimmung
        })
      });
      if (!ins.ok) return res.status(500).json({ error: 'Konnte nicht gespeichert werden.' });
      return res.status(200).json({ success: true, status: filiale === ich ? 'aktiv' : 'angefragt' });
    }

    if (b.gruppe === 'aendern') {
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'Bitte einen Namen für die Filiale eingeben.' });
      await fetch(SUPABASE_URL + '/rest/v1/filial_gruppen' + filter, {
        method: 'PATCH', headers: sbHeaders(),
        body: JSON.stringify({ filiale_name: name, ruhetage: ruhetageNormal(b.ruhetage) })
      });
      return res.status(200).json({ success: true });
    }

    if (b.gruppe === 'entfernen') {
      const war = (bestehende || []).find(f => String(f.filiale_email).toLowerCase() === filiale);
      if (war && (war.status || 'aktiv') === 'aktiv' && filiale !== ich) {
        // Filiale soll es einmal sehen: Zeile bleibt mit Status "getrennt", bis die Filiale quittiert
        await fetch(SUPABASE_URL + '/rest/v1/filial_gruppen' + filter, {
          method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ status: 'getrennt' })
        });
      } else {
        await fetch(SUPABASE_URL + '/rest/v1/filial_gruppen' + filter, { method: 'DELETE', headers: sbHeaders() });
      }
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unbekannte Aktion.' });
  } catch (e) {
    return res.status(500).json({ error: 'Fehler. Bitte versuche es erneut.' });
  }
}

// Darf diese Zentrale die Daten der Filiale lesen? (nur wenn die Filiale zugestimmt hat)
async function istAktiveFiliale(zentrale, filiale) {
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/filial_gruppen?zentrale_email=eq.' + q(zentrale.toLowerCase()) +
      '&filiale_email=eq.' + q(filiale.toLowerCase()) + '&status=eq.aktiv&select=filiale_email&limit=1',
      { headers: sbHeaders() }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}

// Diese Bereiche darf eine Zentrale bei einer zugestimmten Filiale NUR LESEN (Monatsbericht, Tagesgeschäft, Schichtplan)
const LESBAR_FUER_ZENTRALE = [
  'tagesgeschaeft-kassenbuch', 'tagesgeschaeft-wareneingang', 'tagesgeschaeft-belege',
  'tagesgeschaeft-freigetraenke', 'tagesgeschaeft-abschreibungen', 'tagesgeschaeft-stornos',
  'tagesgeschaeft-haccp', 'tagesgeschaeft-notizen', 'tagesgeschaeft-artikelberichte',
  'schichtplaene', 'schichtplan-mitarbeiter'
];

async function neuesteDaten(userEmail, tool) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + q(userEmail) + '&tool_name=eq.' + q(tool) +
    '&select=data&order=updated_at.desc&limit=1',
    { headers: sbHeaders() }
  );
  if (!r.ok) return {};
  const rows = await r.json();
  return (Array.isArray(rows) && rows.length > 0 && rows[0].data) ? rows[0].data : {};
}

// Einzelheiten einer Filiale: Stornos, Freigetränke, Abschreibungen (Zeitraum) und Schichten (Zeitraum)
async function gruppeDetails(req, res, email) {
  const filiale = String(req.query.filiale || '').toLowerCase();
  const von = String(req.query.von || ''), bis = String(req.query.bis || '');
  const svon = String(req.query.svon || ''), sbis = String(req.query.sbis || '');
  const ok = /^\d{4}-\d{2}-\d{2}$/;
  if (!emailOk(filiale) || ![von, bis, svon, sbis].every(d => ok.test(d)) || von > bis || svon > sbis) {
    return res.status(400).json({ error: 'Angaben ungültig.' });
  }
  if (!(await istAktiveFiliale(email, filiale))) return res.status(403).json({ error: 'Kein Zugriff auf diese Filiale.' });
  try {
    const [st, fg, ac, sp] = await Promise.all([
      neuesteDaten(filiale, 'tagesgeschaeft-stornos'),
      neuesteDaten(filiale, 'tagesgeschaeft-freigetraenke'),
      neuesteDaten(filiale, 'tagesgeschaeft-abschreibungen'),
      neuesteDaten(filiale, 'schichtplaene')
    ]);
    const liste = d => Array.isArray(d.items) ? d.items : [];
    const imZ = (d, a, b) => typeof d === 'string' && d >= a && d <= b;
    const text = (v, n) => String(v == null ? '' : v).slice(0, n || 200);
    const zahl = v => (typeof v === 'number' && isFinite(v)) ? v : (parseFloat(v) || 0);
    return res.status(200).json({
      stornos: liste(st).filter(i => imZ(i.datum, von, bis)).map(i => ({ datum: i.datum, betrag: zahl(i.betrag), grund: text(i.grund) })),
      freigetraenke: liste(fg).filter(i => imZ(i.datum, von, bis)).map(i => ({ datum: i.datum, name: text(i.getraenk), menge: zahl(i.menge), einheit: text(i.einheit, 20), wert: zahl(i.wert), grund: text(i.grund) })),
      abschreibungen: liste(ac).filter(i => imZ(i.datum, von, bis)).map(i => ({ datum: i.datum, name: text(i.artikel), menge: zahl(i.menge), einheit: text(i.einheit, 20), wert: zahl(i.wert), grund: text(i.grund) })),
      schichten: liste(sp).filter(i => imZ(i.datum, svon, sbis)).map(i => ({ datum: i.datum, name: text(i.name, 80), von: text(i.von, 10), bis: text(i.bis, 10), notiz: text(i.notiz) }))
    });
  } catch (e) {
    return res.status(500).json({ error: 'Fehler beim Laden.' });
  }
}

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
      '&status=eq.aktiv&select=filiale_email,filiale_name,ruhetage&order=filiale_name.asc&limit=500',
      { headers: sbHeaders() }
    );
    const filialen = await gRes.json();
    if (!Array.isArray(filialen)) return res.status(500).json({ error: 'Fehler beim Laden.' });
    if (filialen.length === 0) {
      const plan = await zentralePlan(email);
      const alle = await zentraleFilialen(email);
      if (!plan && !(alle && alle.length > 0)) return res.status(403).json({ error: 'Kein Zentrale-Zugang.' });
      return res.status(200).json({ von, bis, filialen: [] });
    }

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

      // Ruhetage der Filiale (Kürzel mo,di,mi,do,fr,sa,so) als Zahlen 0=So … 6=Sa
      const wt = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };
      const ruhetage = String(f.ruhetage || '').toLowerCase().split(/[\s,;]+/)
        .map(x => wt[x.slice(0, 2)]).filter(x => x !== undefined);
      return { name: f.filiale_name, email: f.filiale_email, ruhetage, tage };
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
    if (req.query.gruppe === 'check') return gruppeCheck(req, res, email);
    if (req.query.gruppe === 'verwalten') return gruppeVerwalten(req, res, email);
    if (req.query.gruppe === 'details') return gruppeDetails(req, res, email);
    if (req.query.gruppe === 'anfragen') return gruppeAnfragen(req, res, email);
    const tool = req.query.tool;
    if (!tool) return res.status(400).json({ error: 'tool fehlt.' });

    // Zentrale liest (nur lesen) einen Bereich einer zugestimmten Filiale
    let zielNutzer = email;
    if (req.query.filiale) {
      const fil = String(req.query.filiale).toLowerCase();
      if (!LESBAR_FUER_ZENTRALE.includes(tool) || !(await istAktiveFiliale(email, fil))) {
        return res.status(403).json({ error: 'Kein Zugriff.' });
      }
      zielNutzer = fil;
    }

    try {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(zielNutzer) +
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
    if (req.body && req.body.gruppe) return gruppeAktion(req, res, email);
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
