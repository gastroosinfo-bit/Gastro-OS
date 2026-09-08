// api/buch-public.js
// Öffentlicher Zugang per Code + PIN — ohne normales GASTRO-OS-Login.
// Deckt drei "Bücher" ab: uebergabe, reservierung (beide mit Eintragen durch Mitarbeiter)
// und schichtplan (nur lesend für Mitarbeiter — Bearbeiten ist ausschließlich dem
// eingeloggten Chef über /api/tool-data vorbehalten).

const crypto = require('crypto');
const { sendPushToAll } = require('../lib/push-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const TOOL_NAME_BY_TYPE = {
  uebergabe: 'tagesgeschaeft-schicht',
  reservierung: 'reservierungen',
  schichtplan: 'schichtplaene'
};

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };
}
function pinHash(bookType, code, pin) {
  if (bookType === 'uebergabe') {
    return crypto.createHmac('sha256', SUPABASE_SERVICE_KEY || 'fallback').update(code + ':' + pin).digest('hex');
  }
  return crypto.createHmac('sha256', SUPABASE_SERVICE_KEY || 'fallback').update(bookType + ':' + code + ':' + pin).digest('hex');
}

async function findOwnerByCode(zugangTool, code) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?tool_name=eq.' + zugangTool + '&data->>code=eq.' + encodeURIComponent(code) + '&select=user_id,data&limit=1',
    { headers: sbHeaders() }
  );
  const rows = await r.json();
  if (!rows || rows.length === 0) return null;
  return rows[0];
}
async function loadItems(userId, toolName) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.' + toolName + '&select=data&order=updated_at.desc&limit=1',
    { headers: sbHeaders() }
  );
  const rows = await r.json();
  const data = (rows && rows.length > 0 && rows[0].data) ? rows[0].data : {};
  return data.items || [];
}
async function saveItems(userId, toolName, items) {
  const existingRes = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.' + toolName + '&select=id&order=updated_at.desc',
    { headers: sbHeaders() }
  );
  const existingRows = await existingRes.json();
  const payload = { data: { items }, updated_at: new Date().toISOString() };

  if (existingRows && existingRows.length > 0) {
    await fetch(SUPABASE_URL + '/rest/v1/user_tool_data?id=eq.' + existingRows[0].id, {
      method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(payload)
    });
  } else {
    await fetch(SUPABASE_URL + '/rest/v1/user_tool_data', {
      method: 'POST',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ user_id: userId, tool_name: toolName, data: { items } })
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Server nicht konfiguriert.' });

  const { code, pin, bookType, action, text, autor, eintrag } = req.body || {};
  if (!code || !pin) return res.status(400).json({ error: 'Code oder PIN fehlt.' });
  if (!TOOL_NAME_BY_TYPE[bookType]) return res.status(400).json({ error: 'Ungültiger bookType.' });

  const zugangTool = bookType + '-zugang';
  const owner = await findOwnerByCode(zugangTool, code);
  if (!owner || !owner.data || !owner.data.pinHash) {
    return res.status(401).json({ error: 'Ungültiger Code.' });
  }
  if (owner.data.pinHash !== pinHash(bookType, code, pin)) {
    return res.status(401).json({ error: 'Falsche PIN.' });
  }

  const toolName = TOOL_NAME_BY_TYPE[bookType];

  // ─── Übergabebuch: Mitarbeiter dürfen eintragen ────────────────────────
  if (bookType === 'uebergabe' && action === 'add') {
    if (!text || !text.trim()) return res.status(400).json({ error: 'Text fehlt.' });
    const items = await loadItems(owner.user_id, toolName);
    items.push({ id: Date.now(), text: text.trim(), zeitpunkt: new Date().toISOString(), autor: (autor && autor.trim()) || 'Mitarbeiter' });
    await saveItems(owner.user_id, toolName, items);
    sendPushToAll(owner.user_id, '📋 Neuer Übergabe-Eintrag', text.trim().slice(0, 120), '/uebergabe.html?u=' + code, 'uebergabe');
    return res.status(200).json({ items });
  }

  // ─── Reservierungsbuch: Mitarbeiter dürfen eintragen ───────────────────
  if (bookType === 'reservierung' && action === 'add') {
    if (!eintrag || !eintrag.name || !eintrag.datum) return res.status(400).json({ error: 'Name oder Datum fehlt.' });
    const items = await loadItems(owner.user_id, toolName);
    items.push({ id: Date.now(), ...eintrag });
    await saveItems(owner.user_id, toolName, items);
    sendPushToAll(owner.user_id, '📅 Neue Reservierung', `${eintrag.name}, ${eintrag.datum}${eintrag.uhrzeit ? ' ' + eintrag.uhrzeit : ''}${eintrag.personen ? ', ' + eintrag.personen + ' Personen' : ''}`, '/reservierung.html?u=' + code, 'reservierung');
    return res.status(200).json({ items });
  }

  // ─── Schichtplan: Mitarbeiter dürfen NUR lesen, niemals eintragen/löschen ──
  // ─── Default (auch für uebergabe/reservierung ohne action="add"): nur lesen ──
  const items = await loadItems(owner.user_id, toolName);
  return res.status(200).json({ items });
}
