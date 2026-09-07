// api/reservierung-public.js
// Öffentlicher Zugang zum Reservierungsbuch per Code + PIN — ohne normales GASTRO-OS-Login.
// Gleicher Aufbau wie api/uebergabe-public.js, eigener tool_name für Zugang und Daten.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };
}
function pinHash(code, pin) {
  return crypto.createHmac('sha256', SUPABASE_SERVICE_KEY || 'fallback').update('reservierung:' + code + ':' + pin).digest('hex');
}

async function findOwnerByCode(code) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?tool_name=eq.reservierung-zugang&data->>code=eq.' + encodeURIComponent(code) + '&select=user_id,data&limit=1',
    { headers: sbHeaders() }
  );
  const rows = await r.json();
  if (!rows || rows.length === 0) return null;
  return rows[0];
}
async function loadItems(userId) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.reservierungen&select=data&order=updated_at.desc&limit=1',
    { headers: sbHeaders() }
  );
  const rows = await r.json();
  const data = (rows && rows.length > 0 && rows[0].data) ? rows[0].data : {};
  return data.items || [];
}
async function saveItems(userId, items) {
  const existingRes = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.reservierungen&select=id&order=updated_at.desc',
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
      body: JSON.stringify({ user_id: userId, tool_name: 'reservierungen', data: { items } })
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Server nicht konfiguriert.' });

  const { code, pin, action, eintrag, id } = req.body || {};
  if (!code || !pin) return res.status(400).json({ error: 'Code oder PIN fehlt.' });

  const owner = await findOwnerByCode(code);
  if (!owner || !owner.data || !owner.data.pinHash) {
    return res.status(401).json({ error: 'Ungültiger Code.' });
  }
  if (owner.data.pinHash !== pinHash(code, pin)) {
    return res.status(401).json({ error: 'Falsche PIN.' });
  }

  if (action === 'add') {
    if (!eintrag || !eintrag.name || !eintrag.datum) return res.status(400).json({ error: 'Name oder Datum fehlt.' });
    const items = await loadItems(owner.user_id);
    items.push({ id: Date.now(), ...eintrag });
    await saveItems(owner.user_id, items);
    return res.status(200).json({ items });
  }

  if (action === 'delete') {
    if (!id) return res.status(400).json({ error: 'id fehlt.' });
    let items = await loadItems(owner.user_id);
    items = items.filter(r => r.id !== id);
    await saveItems(owner.user_id, items);
    return res.status(200).json({ items });
  }

  // Default: nur Einträge lesen ("verify" / kein action-Wert)
  const items = await loadItems(owner.user_id);
  return res.status(200).json({ items });
}
