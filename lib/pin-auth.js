// lib/pin-auth.js
// Gemeinsame Hilfsfunktionen für den Code+persönliche-PIN-Zugang von Mitarbeitern.
// Liegt bewusst außerhalb von /api/, damit daraus keine eigene HTTP-Route/Vercel-
// Function entsteht (Limit ist bei 12/12 Funktionen erreicht). Wird von
// api/buch-public.js UND api/beleg-upload.js genutzt.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
  };
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

// Team-Mitarbeiterliste — geteilt über alle Bereiche (gleicher Tool-Name
// 'schichtplan-mitarbeiter'). Jeder Eintrag: { name, pin, rechte }.
async function loadMitarbeiter(userId) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
    '&tool_name=eq.schichtplan-mitarbeiter&select=data&order=updated_at.desc&limit=1',
    { headers: sbHeaders() }
  );
  const rows = await r.json();
  const data = (rows && rows.length > 0 && rows[0].data) ? rows[0].data : {};
  if (Array.isArray(data.mitarbeiter)) return data.mitarbeiter;
  // Altformat (nur Namen, keine persönlichen PINs/Rechte) — defensiv als
  // "noch keine PIN vergeben" behandeln, bis im Dashboard migriert wurde.
  if (Array.isArray(data.namen)) {
    return data.namen.map(n => ({ name: n, pin: '', rechte: {} }));
  }
  return [];
}

// Prüft Code + persönliche PIN und den Zugriff auf einen bestimmten Bereich
// (bookType). Gibt bei Erfolg { owner, name } zurück, sonst null + Fehlertext.
async function pruefeZugang(bookType, code, pin) {
  const owner = await findOwnerByCode(bookType + '-zugang', code);
  if (!owner) return { error: 'Ungültiger Code.', status: 401 };
  const mitarbeiterListe = await loadMitarbeiter(owner.user_id);
  const person = mitarbeiterListe.find(m => m.pin && String(m.pin) === String(pin));
  if (!person) return { error: 'Falsche PIN.', status: 401 };
  if (!person.rechte || !person.rechte[bookType]) {
    return { error: 'Für diesen Bereich nicht freigeschaltet. Bitte den Chef fragen.', status: 403 };
  }
  return { owner, name: person.name };
}

module.exports = { sbHeaders, findOwnerByCode, loadMitarbeiter, pruefeZugang };
