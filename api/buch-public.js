// api/buch-public.js
// Öffentlicher Zugang per Code + persönlicher Mitarbeiter-PIN — ohne normales
// GASTRO-OS-Login. Der "Code" identifiziert den Betrieb/Bereich (per Link/QR-Code
// geteilt), die PIN identifiziert automatisch, WER genau fragt: jeder Mitarbeiter
// hat in der Team-Mitarbeiterliste ('schichtplan-mitarbeiter') eine eigene,
// persönliche PIN plus Häkchen, welche Bereiche er nutzen darf. So kann sich
// niemand mehr für einen Kollegen ausgeben (frühere Version nutzte eine einzige,
// geteilte PIN pro Bereich — das ließ genau das zu).
// Deckt sechs Bereiche ab: uebergabe, reservierung (Eintragen durch Mitarbeiter,
// Name kommt automatisch aus der erkannten Person), schichtplan (nur lesend),
// zeiterfassung (Mitarbeiter tragen Kommen/Pause/Gehen ein, sehen aber nur ihre
// eigenen Zeiten), belege (Mitarbeiter laden Belege/Z-Bons hoch) und
// temperaturen (Mitarbeiter tragen HACCP-Temperaturen ein).

const { sendPushToAll } = require('../lib/push-helper');
const { sbHeaders, findOwnerByCode, loadMitarbeiter } = require('../lib/pin-auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const TOOL_NAME_BY_TYPE = {
  uebergabe: 'tagesgeschaeft-schicht',
  reservierung: 'reservierungen',
  schichtplan: 'schichtplaene',
  zeiterfassung: 'zeiterfassung',
  belege: 'tagesgeschaeft-belege',
  temperaturen: 'tagesgeschaeft-haccp'
};

async function loadRaw(userId, toolName) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.' + toolName + '&select=data&order=updated_at.desc&limit=1',
    { headers: sbHeaders() }
  );
  const rows = await r.json();
  return (rows && rows.length > 0 && rows[0].data) ? rows[0].data : {};
}
async function saveRaw(userId, toolName, data) {
  const existingRes = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.' + toolName + '&select=id&order=updated_at.desc',
    { headers: sbHeaders() }
  );
  const existingRows = await existingRes.json();
  const payload = { data, updated_at: new Date().toISOString() };

  if (existingRows && existingRows.length > 0) {
    await fetch(SUPABASE_URL + '/rest/v1/user_tool_data?id=eq.' + existingRows[0].id, {
      method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(payload)
    });
  } else {
    await fetch(SUPABASE_URL + '/rest/v1/user_tool_data', {
      method: 'POST',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ user_id: userId, tool_name: toolName, data })
    });
  }
}
async function loadItems(userId, toolName) {
  const data = await loadRaw(userId, toolName);
  return data.items || [];
}
async function saveItems(userId, toolName, items) {
  await saveRaw(userId, toolName, { items });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Server nicht konfiguriert.' });

  const { code, pin, bookType, action, text, eintrag, datum, zeit, werte, korrekturId, korrekturStart, korrekturEnde, korrekturPausen } = req.body || {};
  if (!code || !pin) return res.status(400).json({ error: 'Code oder PIN fehlt.' });

  // ─── "team": nur Person + ihre Rechte ermitteln (für die Team-Zugang-Startseite
  // mit den Bereichs-Buttons) — prüft absichtlich KEIN einzelnes rechte[bookType],
  // da hier ja erst rausgefunden werden soll, was die Person überhaupt darf. ──
  if (bookType === 'team') {
    const owner = await findOwnerByCode('team-zugang', code);
    if (!owner) return res.status(401).json({ error: 'Ungültiger Code.' });
    const mitarbeiterListe = await loadMitarbeiter(owner.user_id);
    const person = mitarbeiterListe.find(m => m.pin && String(m.pin) === String(pin));
    if (!person) return res.status(401).json({ error: 'Falsche PIN.' });
    return res.status(200).json({ meinName: person.name, rechte: person.rechte || {} });
  }

  if (!TOOL_NAME_BY_TYPE[bookType]) return res.status(400).json({ error: 'Ungültiger bookType.' });

  const zugangTool = bookType + '-zugang';
  const owner = await findOwnerByCode(zugangTool, code);
  if (!owner) {
    return res.status(401).json({ error: 'Ungültiger Code.' });
  }

  // Die persönliche PIN identifiziert automatisch, wer fragt — kein Namens-Eintippen
  // oder -Auswählen mehr nötig, und niemand kann sich mehr für einen Kollegen ausgeben.
  const mitarbeiterListe = await loadMitarbeiter(owner.user_id);
  const person = mitarbeiterListe.find(m => m.pin && String(m.pin) === String(pin));
  if (!person) {
    return res.status(401).json({ error: 'Falsche PIN.' });
  }
  if (!person.rechte || !person.rechte[bookType]) {
    return res.status(403).json({ error: 'Für diesen Bereich nicht freigeschaltet. Bitte den Chef fragen.' });
  }
  const name = person.name;

  const toolName = TOOL_NAME_BY_TYPE[bookType];

  // ─── Übergabebuch: Mitarbeiter dürfen eintragen ────────────────────────
  if (bookType === 'uebergabe' && action === 'add') {
    if (!text || !text.trim()) return res.status(400).json({ error: 'Text fehlt.' });
    const items = await loadItems(owner.user_id, toolName);
    items.push({ id: Date.now(), text: text.trim(), zeitpunkt: new Date().toISOString(), autor: name });
    await saveItems(owner.user_id, toolName, items);
    sendPushToAll(owner.user_id, '📋 Neuer Übergabe-Eintrag', text.trim().slice(0, 120), '/uebergabe.html?u=' + code, 'uebergabe');
    return res.status(200).json({ items, meinName: name });
  }

  // ─── Reservierungsbuch: Mitarbeiter dürfen eintragen ───────────────────
  if (bookType === 'reservierung' && action === 'add') {
    if (!eintrag || !eintrag.name || !eintrag.datum) return res.status(400).json({ error: 'Name oder Datum fehlt.' });
    const items = await loadItems(owner.user_id, toolName);
    items.push({ id: Date.now(), ...eintrag, erfasstVon: name });
    await saveItems(owner.user_id, toolName, items);
    sendPushToAll(owner.user_id, '📅 Neue Reservierung', `${eintrag.name}, ${eintrag.datum}${eintrag.uhrzeit ? ' ' + eintrag.uhrzeit : ''}${eintrag.personen ? ', ' + eintrag.personen + ' Personen' : ''}`, '/reservierung.html?u=' + code, 'reservierung');
    return res.status(200).json({ items, meinName: name });
  }

  // ─── Belege: Mitarbeiter dürfen Belege/Z-Bons eintragen (Datei kommt vorher
  // separat über api/beleg-upload.js — hier wird nur der Metadaten-Eintrag mit
  // dem bereits hochgeladenen storagePath gespeichert). ──────────────────────
  if (bookType === 'belege' && action === 'add') {
    if (!eintrag || !eintrag.plattform || !eintrag.datum) return res.status(400).json({ error: 'Anbieter oder Datum fehlt.' });
    const items = await loadItems(owner.user_id, toolName);
    items.push({ id: Date.now(), ...eintrag, erfasstVon: name });
    await saveItems(owner.user_id, toolName, items);
    sendPushToAll(owner.user_id, '🧾 Neuer Beleg', name + ' hat einen Beleg (' + eintrag.plattform + ') hochgeladen.', '/belegablage.html', 'belege');
    return res.status(200).json({ items, meinName: name });
  }

  // ─── Temperaturen: Mitarbeiter tragen HACCP-Werte für vorhandene Geräte ein.
  // Werte werden pro Tag zusammengeführt (nicht überschrieben), damit nicht ein
  // Mitarbeiter die Einträge eines anderen für denselben Tag versehentlich löscht. ─
  if (bookType === 'temperaturen') {
    const raw = await loadRaw(owner.user_id, toolName);
    const geraete = raw.geraete || [];
    if (action === 'eintragen') {
      if (!datum || !werte || typeof werte !== 'object') return res.status(400).json({ error: 'Datum oder Werte fehlen.' });
      const eintraege = raw.eintraege || {};
      eintraege[datum] = { ...(eintraege[datum] || {}), ...werte };
      await saveRaw(owner.user_id, toolName, { geraete, eintraege });
      sendPushToAll(owner.user_id, '🌡️ Temperaturen eingetragen', name + ' hat Temperaturen für ' + datum + ' eingetragen.', '/tagesgeschaeft.html', 'temperaturen');
    }
    return res.status(200).json({ geraete, meinName: name });
  }

  // ─── Zeiterfassung: Mitarbeiter tragen Kommen/Pause/Gehen für sich selbst ein ──
  // Wichtig: hier wird — anders als bei uebergabe/reservierung/schichtplan — NICHT die
  // komplette Liste zurückgegeben, sondern nur die Einträge des anfragenden Mitarbeiters
  // (Datenschutz: Kollegen sollen die Zeiten der anderen nicht sehen können).
  if (bookType === 'zeiterfassung') {
    let items = await loadItems(owner.user_id, toolName);

    if (['kommen', 'pause_start', 'pause_ende', 'gehen'].includes(action)) {
      if (!datum || !zeit) return res.status(400).json({ error: 'Datum oder Zeit fehlt.' });

      if (action === 'kommen') {
        const bereitsOffen = items.find(i => i.name === name && i.datum === datum && !i.ende);
        if (!bereitsOffen) {
          items.push({ id: Date.now(), name, datum, start: zeit, pausen: [], pauseLaufend: null, ende: null, status: 'offen' });
          await saveItems(owner.user_id, toolName, items);
          sendPushToAll(owner.user_id, '⏱️ Kommt', name + ' hat sich um ' + zeit + ' Uhr eingetragen.', '/dashboard.html', 'zeiterfassung');
        }
      } else {
        const eintragZe = items.find(i => i.name === name && i.datum === datum && !i.ende);
        if (eintragZe) {
          if (action === 'pause_start' && !eintragZe.pauseLaufend) {
            eintragZe.pauseLaufend = zeit;
            await saveItems(owner.user_id, toolName, items);
          } else if (action === 'pause_ende' && eintragZe.pauseLaufend) {
            eintragZe.pausen.push({ von: eintragZe.pauseLaufend, bis: zeit });
            eintragZe.pauseLaufend = null;
            await saveItems(owner.user_id, toolName, items);
          } else if (action === 'gehen') {
            if (eintragZe.pauseLaufend) {
              eintragZe.pausen.push({ von: eintragZe.pauseLaufend, bis: zeit });
              eintragZe.pauseLaufend = null;
            }
            eintragZe.ende = zeit;
            await saveItems(owner.user_id, toolName, items);
            sendPushToAll(owner.user_id, '⏱️ Feierabend', name + ' hat sich um ' + zeit + ' Uhr ausgetragen — bitte im Dashboard genehmigen.', '/dashboard.html', 'zeiterfassung');
          }
        }
      }
    }

    if (action === 'korrigieren') {
      if (!korrekturId) return res.status(400).json({ error: 'Eintrag-ID fehlt.' });
      const eintragKorr = items.find(i => i.id === korrekturId && i.name === name);
      if (!eintragKorr) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
      if (eintragKorr.status !== 'abgelehnt') return res.status(400).json({ error: 'Nur abgelehnte Einträge können korrigiert werden.' });
      if (korrekturStart) eintragKorr.start = korrekturStart;
      if (korrekturEnde) eintragKorr.ende = korrekturEnde;
      if (Array.isArray(korrekturPausen)) eintragKorr.pausen = korrekturPausen;
      eintragKorr.status = 'offen';
      delete eintragKorr.notiz;
      await saveItems(owner.user_id, toolName, items);
      sendPushToAll(owner.user_id, '✏️ Korrigiert', name + ' hat einen abgelehnten Eintrag korrigiert und erneut eingereicht.', '/dashboard.html', 'zeiterfassung');
    }

    const meineItems = items.filter(i => i.name === name);
    return res.status(200).json({ items: meineItems, meinName: name });
  }

  // ─── Schichtplan: Mitarbeiter dürfen NUR lesen, niemals eintragen/löschen ──
  // ─── Default (auch für uebergabe/reservierung ohne action="add"): nur lesen ──
  const items = await loadItems(owner.user_id, toolName);
  return res.status(200).json({ items, meinName: name });
}
