// api/push-subscribe-public.js
// Registriert die Push-Subscription eines MITARBEITERS (ohne Login, nur per Code+PIN)
// für Übergabebuch ODER Reservierungsbuch — landet in derselben gemeinsamen Liste wie
// die Subscription des Inhabers, damit alle bei neuen Einträgen benachrichtigt werden.

const crypto = require('crypto');
const { addSubscription } = require('../lib/push-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };
}

// Gleiche Hash-Formeln wie in uebergabe-public.js / reservierung-public.js
function pinHashUebergabe(code, pin) {
  return crypto.createHmac('sha256', SUPABASE_SERVICE_KEY || 'fallback').update(code + ':' + pin).digest('hex');
}
function pinHashReservierung(code, pin) {
  return crypto.createHmac('sha256', SUPABASE_SERVICE_KEY || 'fallback').update('reservierung:' + code + ':' + pin).digest('hex');
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Server nicht konfiguriert.' });

  const { code, pin, bookType, subscription } = req.body || {};
  if (!code || !pin || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Fehlende Angaben.' });
  }
  if (bookType !== 'uebergabe' && bookType !== 'reservierung') {
    return res.status(400).json({ error: 'Ungültiger bookType.' });
  }

  const zugangTool = bookType === 'uebergabe' ? 'uebergabe-zugang' : 'reservierung-zugang';
  const owner = await findOwnerByCode(zugangTool, code);
  if (!owner || !owner.data || !owner.data.pinHash) {
    return res.status(401).json({ error: 'Ungültiger Code.' });
  }
  const erwarteterHash = bookType === 'uebergabe' ? pinHashUebergabe(code, pin) : pinHashReservierung(code, pin);
  if (owner.data.pinHash !== erwarteterHash) {
    return res.status(401).json({ error: 'Falsche PIN.' });
  }

  try {
    await addSubscription(owner.user_id, subscription);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Fehler beim Speichern.' });
  }
}
