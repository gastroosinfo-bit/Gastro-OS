// GASTRO-OS — Checklisten-Speicherung + Navigation
(function() {

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

  // ─── Checklisten-Speicherung (jetzt über eigene API-Route, kein direkter Supabase-Zugriff mehr) ──
  function getToolName() {
    const file = window.location.pathname.split('/').pop().replace('.html','').replace(/-/g,'_');
    return 'checklist_' + file;
  }

  async function loadState() {
    try {
      const res = await fetch('/api/tool-data?tool=' + encodeURIComponent(getToolName()));
      if (!res.ok) return {};
      const d = await res.json();
      return d.data || {};
    } catch (e) {}
    return {};
  }

  async function saveState(state) {
    try {
      await fetch('/api/tool-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: getToolName(), data: state })
      });
    } catch (e) {}
  }

  // ─── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    addDashboardButton();

    // verify-session prüft nur, ob eingeloggt ist (für UI-Gating) —
    // die eigentliche Identität/Berechtigung prüft /api/tool-data selbst über das Cookie.
    try {
      const res = await fetch('/api/verify-session');
      if (!res.ok) return;
      const d = await res.json();
      if (!d.valid) return;
    } catch (e) { return; }

    const checkboxes = document.querySelectorAll('.checkliste input[type=checkbox]');
    if (checkboxes.length === 0) return;

    const state = await loadState();
    checkboxes.forEach(function(cb, i) {
      if (state['cb_' + i]) {
        cb.checked = true;
        cb.parentElement.classList.add('done');
      }
      cb.addEventListener('change', async function() {
        cb.parentElement.classList.toggle('done', cb.checked);
        const s = {};
        checkboxes.forEach(function(c, j) { if (c.checked) s['cb_' + j] = true; });
        await saveState(s);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
