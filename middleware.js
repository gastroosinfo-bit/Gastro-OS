// middleware.js – Vercel Edge Middleware ohne Next.js

export default async function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Öffentliche Pfade — kein Login nötig
  const publicPaths = ['/login.html', '/api/check-auth'];
  if (publicPaths.some(p => pathname.startsWith(p))) {
    return new Response(null, { status: 200 });
  }

  // Statische Dateien durchlassen
  if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|mp4|webp)$/.test(pathname)) {
    return new Response(null, { status: 200 });
  }

  // Session-Cookie prüfen
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/gastro_os_session=([^;]+)/);
  const token = match ? match[1] : null;

  if (!token) {
    // Nicht eingeloggt → zur Login-Seite
    return Response.redirect(new URL('/login.html', request.url), 302);
  }

  try {
    const SESSION_SECRET = process.env.SESSION_SECRET;
    const decoded = atob(token);
    const parts = decoded.split('|');

    if (parts.length !== 3) {
      return Response.redirect(new URL('/login.html', request.url), 302);
    }

    const [email, expires] = parts;

    // Abgelaufen?
    if (Date.now() > parseInt(expires)) {
      return Response.redirect(new URL('/login.html', request.url), 302);
    }

    // Token gültig → durchlassen
    return new Response(null, { status: 200 });

  } catch {
    return Response.redirect(new URL('/login.html', request.url), 302);
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
