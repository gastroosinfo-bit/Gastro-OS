// app-push-shim.js
// Läuft NUR in der GASTRO-OS-Android-App (User-Agent enthält "GastroOSApp"). Dort gibt es kein
// Web-Push; stattdessen liefert die App ein Firebase-Token (window.GASTRO_FCM_TOKEN).
// Dieses Skript tut so, als wäre es ein Browser-Push-Dienst, damit die bestehenden Seiten
// (Dashboard, Übergabe, Reservierung, Schichtplan, Zeiterfassung, Team-Zugang) unverändert
// funktionieren: "Abo" = { endpoint: 'fcm:<Token>', fcmToken: '<Token>' }.
// In jedem normalen Browser passiert hier nichts.
(function () {
  if (!/GastroOSApp/.test(navigator.userAgent)) return;

  var FLAG = 'gastroos_fcm_aktiv';

  function warteAufToken(ms) {
    return new Promise(function (resolve, reject) {
      if (window.GASTRO_FCM_TOKEN) return resolve(window.GASTRO_FCM_TOKEN);
      var timer = setTimeout(function () {
        window.removeEventListener('gastro-fcm-token', h);
        reject(new Error('Kein Firebase-Token'));
      }, ms || 10000);
      function h() {
        if (!window.GASTRO_FCM_TOKEN) return;
        clearTimeout(timer);
        window.removeEventListener('gastro-fcm-token', h);
        resolve(window.GASTRO_FCM_TOKEN);
      }
      window.addEventListener('gastro-fcm-token', h);
    });
  }

  function flagLesen() { try { return localStorage.getItem(FLAG) === '1'; } catch (e) { return false; } }
  function flagSetzen(an) {
    try { if (an) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch (e) {}
  }

  function neuesAbo(token) {
    return {
      endpoint: 'fcm:' + token,
      fcmToken: token,
      unsubscribe: function () { flagSetzen(false); return Promise.resolve(true); }
    };
  }

  var reg = {
    scope: '/',
    pushManager: {
      getSubscription: function () {
        if (!flagLesen()) return Promise.resolve(null);
        return warteAufToken(5000).then(neuesAbo, function () { return null; });
      },
      subscribe: function () {
        return warteAufToken(10000).then(function (t) { flagSetzen(true); return neuesAbo(t); });
      }
    }
  };

  var sw = {
    register: function () { return Promise.resolve(reg); },
    getRegistration: function () { return Promise.resolve(reg); },
    ready: Promise.resolve(reg),
    controller: null,
    addEventListener: function () {},
    removeEventListener: function () {}
  };

  try { Object.defineProperty(navigator, 'serviceWorker', { get: function () { return sw; }, configurable: true }); } catch (e) {}
  if (!window.PushManager) window.PushManager = function PushManager() {};
  // Die Berechtigung fragt die App selbst bei Android ab.
  window.Notification = { permission: 'granted', requestPermission: function () { return Promise.resolve('granted'); } };
})();
