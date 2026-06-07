// GASTRO-OS — Checklisten-Speicherung + Navigation
(function() {
  const SUPABASE_URL = 'https://hchlganbgjeciwhwaisj.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjaGxnYW5iZ2plY2l3aHdhaXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMzA0NjAsImV4cCI6MjA5MTgwNjQ2MH0.mA6oAPJCCgFq5LIUPFDGM0WI_le6STHTuGiwLtGMgu8';

  // ─── Dashboard-Button ───────────────────────────────────────────────────────
  function addDashboardButton() {
    const file = window.location.pathname.split('/').pop();
    const skip = ['dashboard.html','login.html','impressum.html','datenschutz.html','agb.html','modul0-reflexion.html',''];
    if (skip.includes(file)) return;
    if (document.querySelector('.gastro-db-added')) return;

    const style = document.createElement('style');
    style.textContent = '.gastro-db-added{display:inline-block;background:#d4af37;color:#1a2a4a;border:none;padding:10px 22px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;transition:all 0.2s;}.gastro-db-added:hover{background:#c8a030;color:#1a2a4a;}.gastro-db-wrap{text-align:right;margin-top:24px;margin-bottom:8px;}';
    document.head.appendChild(style);

    const navRow = document.querySelector('.nav-row');

    if (navRow) {
      const hasForward = navRow.innerHTML.includes('→');
      if (hasForward) {
        // Folge-Lektion vorhanden — kein Dashboard-Button, nav-row bleibt
        return;
      } else {
        // Letzte Lektion — nav-row entfernen, nur Dashboard-Button zeigen
        const wrap = document.createElement('div');
        wrap.className = 'gastro-db-wrap';
        wrap.innerHTML = '<a href="dashboard.html" class="gastro-db-added">← Zurück zum Dashboard</a>';
        navRow.parentNode.replaceChild(wrap, navRow);
      }
    } else {
      // Kein nav-row — Button am Ende des Inhaltsbereichs
      const content = document.querySelector('.wrap, .main, .content-wrap');
      if (content) {
        const wrap = document.createElement('div');
        wrap.className = 'gastro-db-wrap';
        wrap.innerHTML = '<a href="dashboard.html" class="gastro-db-added">← Zurück zum Dashboard</a>';
        content.appendChild(wrap);
      }
    }
  }

  // ─── Checklisten-Speicherung ───────────────────────────────────────────────
  function getToolName() {
    const file = window.location.pathname.split('/').pop().replace('.html','').replace(/-/g,'_');
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
        SUPABASE_URL + '/rest/v1/user_tool_data?user_id=eq.' + encodeURIComponent(userId) +
        '&tool_name=eq.' + getToolName() + '&select=data',
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

  // ─── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    addDashboardButton();

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
