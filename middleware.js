// middleware.js
// Vercel Edge Middleware – schützt alle Seiten außer login.html und api/

import { NextResponse } from 'next/server';

const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_DAYS = 30;

// Seiten die OHNE Login erreichbar sind
const PUBLIC_PATHS = ['/login.html', '/api/check-auth'];

async function verifySession(token) {
  if (!token) return false;
  try {
    const decoded = atob(token);
    const parts = decoded.split('|');
    if (parts.length !== 3) return false;

    const [email, expires, sig] = parts;

    // Abgelaufen?
    if (Date.now() > parseInt(expires)) return false;

    // Signatur prüfen
    const data = `${email}|${expires}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(SESSION_SECRET);
    const messageData = encoder.encode(data);

    const key = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuffer = await crypto.subtle.sign('HMAC', key, messageData);
    const expectedSig = Array.from(new Uint8Array(sigBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    return sig === expectedSig;
  } catch {
    return false;
  }
}

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  // Öffentliche Pfade durchlassen
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Statische Dateien durchlassen (CSS, Bilder etc.)
  if (pathname.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2)$/)) {
    return NextResponse.next();
  }

  // Session-Cookie prüfen
  const sessionToken = request.cookies.get('gastro_os_session')?.value;
  const isValid = await verifySession(sessionToken);

  if (!isValid) {
    // Nicht eingeloggt → zur Login-Seite
    return NextResponse.redirect(new URL('/login.html', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
