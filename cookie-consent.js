/**
 * GASTRO-OS – Cookie-Consent-Script
 * Einbindung auf jeder Seite: <script src="/cookie-consent.js"></script>
 * (Pfad ggf. anpassen, je nachdem wo die Datei liegt, z.B. /assets/cookie-consent.js)
 *
 * Was es macht:
 * - Zeigt beim ersten Besuch einen Banner, der um Zustimmung zu Google Analytics bittet
 * - GA4 wird NUR geladen, wenn "Akzeptieren" geklickt wurde
 * - Die Entscheidung wird in localStorage gespeichert (kein erneutes Fragen bei jedem Besuch)
 * - Fügt automatisch einen kleinen "Cookie-Einstellungen"-Link ein, über den man
 *   die Wahl jederzeit ändern kann (unten links, unabhängig vom restlichen Footer)
 */
(function () {
  var GA_MEASUREMENT_ID = 'G-HHLPP8XHSY';
  var DATENSCHUTZ_URL = 'https://mein-gastro-system.de/datenschutz.html';

  // ---- Styles (im Site-Design: Navy / Gold / Cream) ----
  var css = `
    .cookie-banner {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: #1C2340;
      color: #FFFFFF;
      padding: 20px 24px;
      box-shadow: 0 -6px 24px rgba(0,0,0,0.25);
      z-index: 9999;
      display: none;
      flex-wrap: wrap;
      gap: 16px;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid rgba(154,125,58,0.3);
      font-family: 'DM Sans', sans-serif;
    }
    .cookie-banner p {
      font-size: 13.5px;
      color: rgba(255,255,255,0.8);
      max-width: 620px;
      line-height: 1.6;
      margin: 0;
    }
    .cookie-banner a { color: #C4A55A; text-decoration: underline; }
    .cookie-actions { display: flex; gap: 12px; flex-shrink: 0; margin-left: auto; }
    .cookie-btn {
      padding: 11px 22px;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      transition: background 0.15s;
    }
    .cookie-btn.accept { background: #9A7D3A; color: #FFFFFF; border: none; }
    .cookie-btn.accept:hover { background: #C4A55A; }
    .cookie-btn.reject { background: transparent; color: rgba(255,255,255,0.75); border: 1px solid rgba(255,255,255,0.3); }
    .cookie-btn.reject:hover { background: rgba(255,255,255,0.08); }
    .cookie-settings-link {
      position: fixed;
      left: 16px;
      bottom: 16px;
      z-index: 9998;
      background: #1C2340;
      color: rgba(255,255,255,0.65);
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      padding: 8px 14px;
      border-radius: 100px;
      text-decoration: none;
      border: 1px solid rgba(154,125,58,0.3);
    }
    .cookie-settings-link:hover { color: #C4A55A; }
    @media (max-width: 600px) {
      .cookie-banner { padding: 18px 20px 20px; }
      .cookie-actions { width: 100%; margin-left: 0; }
      .cookie-btn { flex: 1; text-align: center; }
    }
  `;
  var styleTag = document.createElement('style');
  styleTag.textContent = css;
  document.head.appendChild(styleTag);

  // ---- gtag stub (immer vorhanden, damit gtag() nie einen Fehler wirft) ----
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  function loadAnalytics() {
    if (window.gaLoaded) return;
    window.gaLoaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
    document.head.appendChild(s);
    gtag('js', new Date());
    gtag('config', GA_MEASUREMENT_ID);
  }

  // ---- Banner + Einstellungen-Link bauen ----
  function buildBanner() {
    var banner = document.createElement('div');
    banner.id = 'cookie-banner';
    banner.className = 'cookie-banner';
    banner.innerHTML =
      '<p>Wir nutzen Cookies, um diese Website zu analysieren und zu verbessern (Google Analytics). ' +
      'Du entscheidest, ob das für dich okay ist. Mehr dazu in unserer ' +
      '<a href="' + DATENSCHUTZ_URL + '">Datenschutzerklärung</a>.</p>' +
      '<div class="cookie-actions">' +
      '<button type="button" class="cookie-btn reject">Nur notwendige</button>' +
      '<button type="button" class="cookie-btn accept">Akzeptieren</button>' +
      '</div>';
    document.body.appendChild(banner);

    banner.querySelector('.cookie-btn.accept').addEventListener('click', function () { setConsent(true); });
    banner.querySelector('.cookie-btn.reject').addEventListener('click', function () { setConsent(false); });

    var settingsLink = document.createElement('a');
    settingsLink.href = '#';
    settingsLink.id = 'cookie-settings-link';
    settingsLink.className = 'cookie-settings-link';
    settingsLink.textContent = 'Cookie-Einstellungen';
    settingsLink.addEventListener('click', function (e) {
      e.preventDefault();
      showBanner();
    });
    document.body.appendChild(settingsLink);
  }

  function showBanner() {
    var banner = document.getElementById('cookie-banner');
    if (banner) banner.style.display = 'flex';
  }
  function hideBanner() {
    var banner = document.getElementById('cookie-banner');
    if (banner) banner.style.display = 'none';
  }

  function setConsent(granted) {
    localStorage.setItem('cookie_consent', granted ? 'granted' : 'denied');
    hideBanner();
    if (granted) loadAnalytics();
  }

  function init() {
    buildBanner();
    var consent = localStorage.getItem('cookie_consent');
    if (consent === 'granted') {
      loadAnalytics();
    } else if (consent !== 'denied') {
      showBanner();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
