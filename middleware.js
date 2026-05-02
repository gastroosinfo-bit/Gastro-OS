// middleware.js – Vercel Edge Middleware für statische HTML-Seiten

export default async function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Öffentliche Pfade — einfach durchlassen
  if (
    pathname === '/login.html' ||
    pathname === '/' ||
    pathname.startsWith('/api/check-auth') ||
    /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|mp4|webp|json)$/.test(pathname)
  ) {
    return; // Vercel bedient die Datei normal
  }

  // Session-Cookie prüfen
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/gastro_os_session=([^;]+)/);
  const token = match ? match[1] : null;

  if (!token) {
    return Response.redirect(new URL('/login.html', request.url), 302);
  }

  try {
    const decoded = atob(token);
    const parts = decoded.split('|');

    if (parts.length !== 3) {
      return Response.redirect(new URL('/login.html', request.url), 302);
    }

    const expires = parseInt(parts[1]);

    if (Date.now() > expires) {
      return Response.redirect(new URL('/login.html', request.url), 302);
    }

    // Token gültig — Vercel bedient die Datei normal
    return;

  } catch {
    return Response.redirect(new URL('/login.html', request.url), 302);
  }
}

export const config = {
  matcher: ['/((?!_next).*)'],
};
