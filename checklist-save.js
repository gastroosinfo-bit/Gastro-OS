// GASTRO-OS — Checklisten-Speicherung
// Dieses Script speichert den Status aller Checklisten-Haken in Supabase.
// Einfach als <script src="checklist-save.js"></script> vor </body> einbinden.

(function() {
  const SUPABASE_URL = 'https://hchlganbgjeciwhwaisj.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjaGxnYW5iZ2plY2l3aHdhaXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMzA0NjAsImV4cCI6MjA5MTgwNjQ2MH0.mA6oAPJCCgFq5LIUPFDGM0WI_le6STHTuGiwLtGMgu8';

  // Tool-Name aus dem Dateinamen ableiten (z.B. "checklist_modul0_lektion1")
  function getToolName() {
    const path = window.location.pathname;
    const file = path.split('/').pop().replace('.html', '').replace(/-/g, '_');
    return 'checklist_' + file;
  }

  // Supabase Headers
  function headers() {
    return {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY
    };
  }

  // Alle Checkboxen auf der Seite finden
  function getCheckboxes() {
    return document.querySelectorAll('.checkliste input[type=checkbox]');
  }

  // Status laden
  async function loadState(userId) {
    const toolName = getToolName();
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) + '&tool_name=eq.' + toolName + '&select=data',
        { headers: headers() }
      );
      const rows = await res.json();
      if (rows && rows.length > 0 && rows[0].data) {
        return rows[0].data;
      }
    } catch(e) {}
    return {};
  }

  // Status speichern
  async function saveState(userId, state) {
    const toolName = getToolName();
    try {
      await fetch(
        SUPABASE_URL + '/rest/v1/user_tool_data',
        {
          method: 'POST',
          headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({
            user_id: userId,
            tool_name: toolName,
            data: state,
            updated_at: new Date().toISOString()
          })
        }
      );
    } catch(e) {}
  }

  // Checkboxen mit Supabase verbinden
  async function init() {
    // Session holen
    let userEmail = null;
    try {
      const res = await fetch('/api/verify-session');
      if (!res.ok) return;
      const d = await res.json();
      if (!d.valid) return;
      userEmail = d.email;
    } catch(e) { return; }

    const checkboxes = getCheckboxes();
    if (checkboxes.length === 0) return;

    // Gespeicherten Status laden und anwenden
    const state = await loadState(userEmail);
    checkboxes.forEach(function(cb, i) {
      const key = 'cb_' + i;
      if (state[key]) {
        cb.checked = true;
        cb.parentElement.classList.add('done');
      }

      // Bei Änderung speichern
      cb.addEventListener('change', async function() {
        cb.parentElement.classList.toggle('done', cb.checked);
        const currentState = {};
        checkboxes.forEach(function(c, j) {
          if (c.checked) currentState['cb_' + j] = true;
        });
        await saveState(userEmail, currentState);
      });
    });
  }

  // Nach DOM-Load starten
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
