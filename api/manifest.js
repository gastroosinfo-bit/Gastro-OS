// api/manifest.js
// Erzeugt dynamisch die Web-App-Manifest-Datei für Übergabe-, Reservierungs- und
// Schichtplan-Links MIT eingebettetem Mitarbeiter-Code (?type=...&code=...).
// Statische Manifest-Dateien können den individuellen Code pro Betrieb nicht abbilden —
// deshalb muss diese Datei live pro Anfrage erzeugt werden, sonst würde Android beim
// "Installieren" den Code aus der URL verlieren und immer die Chef-Ansicht ohne Code öffnen.

const TITEL = {
  uebergabe: { name: 'Übergabebuch – GASTRO-OS', short_name: 'Übergabebuch' },
  reservierung: { name: 'Reservierungsbuch – GASTRO-OS', short_name: 'Reservierung' },
  schichtplan: { name: 'Schichtplan – GASTRO-OS', short_name: 'Schichtplan' }
};

export default function handler(req, res) {
  const { type, code } = req.query;
  if (!TITEL[type] || !code) {
    return res.status(400).json({ error: 'Ungültige Parameter.' });
  }
  const url = '/' + type + '.html?u=' + encodeURIComponent(code);
  const manifest = {
    name: TITEL[type].name,
    short_name: TITEL[type].short_name,
    start_url: url,
    scope: '/' + type + '.html',
    id: url,
    display: 'standalone',
    background_color: '#f5f0e8',
    theme_color: '#1a2a4a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  };
  res.setHeader('Content-Type', 'application/manifest+json');
  return res.status(200).json(manifest);
}
