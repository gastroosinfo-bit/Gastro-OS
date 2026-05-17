// GASTRO-OS — Checklisten-Speicherung + Navigation
// Speichert Haken-Status und fügt Dashboard-Button automatisch ein.

(function() {
  const SUPABASE_URL = 'https://hchlganbgjeciwhwaisj.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjaGxnYW5iZ2plY2l3aHdhaXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMzA0NjAsImV4cCI6MjA5MTgwNjQ2MH0.mA6oAPJCCgFq5LIUPFDGM0WI_le6STHTuGiwLtGMgu8';

  // ─── Dashboard-Button ───────────────────────────────────────────────────────

  function addDashboardButton() {
    // Nicht auf Dashboard/Login/Legal-Seiten
    const path = window.location.pathname;
    const file = path.split('/').pop();
    const skip = ['dashboard.html','login.html','impressum.html','datenschutz.html','agb.html',''];
    if (skip.includes(file)) return;

    // Bereits vorhanden?
    if (document.querySelector('.gastro-dashboard-btn')) return;

    // Button-Styles
    const style = document.createElement('style');
    style.textContent = '.gastro-dashboard-btn{display:inline-block;background:#d4af37;color:#1a2a4a;border:none;padding:10px 22px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;transition:all 0.2s;}.gastro-dashboard-btn:hover{background:#c8a030;color:#1a2a4a;}.gastro-dashboard-row{text-align:right;margin:20px 0 8px;padding:0 0 4px;}';
    document.head.appendChild(style);

    const btn = '<div class="gastro-dashboard-row"><a href="dashboard.html" class="gastro-dashboard-btn">← Zurück zum Dashboard</a></div>';

    // nav-row prüfen
    const navRow = document.querySelector('.nav-row');

    if (navRow) {
      // Hat die nav-row einen Vorwärts-Pfeil? (→ = Folge-Lektion vorhanden)
      const hasForward = navRow.innerHTML.includes('→');
      if (hasForward) return; // Folge-Lektion vorhanden — kein Dashboard-Button
      // Letzte Lektion — Button nach nav-row einfügen
      navRow.insertAdjacentHTML('afterend', btn);
    } else {
      // Kein nav-row — Button vor Footer einfügen
      const footer = document.querySelector('.gold-bar, .footer-main, .footer-brand, .footer');
      if (footer) {
        footer.insertAdjacentHTML('beforebegin', btn);
      }
    }
  }

  // ─── Checklisten-Speicherung ────────────────────────────────────────────────

  function getToolName() {
    const path = window.location.pathname;
    const file = path.split('/').pop().replace('.html', '').replace(/-/g, '_');
    return 'checklist_' + file;
  }

  function sbHeaders() {
    return {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY
    };
  }

  async function loadState(userId) {
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) + '&tool_name=eq.' + getToolName() + '&select=data',
        { headers: sbHeaders() }
      );
      const rows = await res.json();
      if (rows && rows.length > 0 && rows[0].data) return rows[0].data;
    } catch(e) {}
    return {};
  }

  async function saveState(userId, state) {
    try {
      await fetch(SUPABASE_URL + '/rest/v1/user_tool_data', {
        method: 'POST',
        headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          user_id: userId,
          tool_name: getToolName(),
          data: state,
          updated_at: new Date().toISOString()
        })
      });
    } catch(e) {}
  }

  // ─── Init ────────────────────────────────────────────────────────────────────

  async function init() {
    // Dashboard-Button sofort einfügen
    addDashboardButton();

    // Session für Checklisten
    let userEmail = null;
    try {
      const res = await fetch('/api/verify-session');
      if (!res.ok) return;
      const d = await res.json();
      if (!d.valid) return;
      userEmail = d.email;
    } catch(e) { return; }

    const checkboxes = document.querySelectorAll('.checkliste input[type=checkbox]');
    if (checkboxes.length === 0) return;

    const state = await loadState(userEmail);
    checkboxes.forEach(function(cb, i) {
      if (state['cb_' + i]) {
        cb.checked = true;
        cb.parentElement.classList.add('done');
      }
      cb.addEventListener('change', async function() {
        cb.parentElement.classList.toggle('done', cb.checked);
        const s = {};
        checkboxes.forEach(function(c, j) { if (c.checked) s['cb_' + j] = true; });
        await saveState(userEmail, s);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
