import { NextResponse } from 'next/server';
import crypto from 'crypto';

const SESSION_SECRET = process.env.SESSION_SECRET;

function verifySession(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 3) return null;
    const [email, expires, sig] = parts;
    if (Date.now() > parseInt(expires)) return null;
    const data = `${email}|${expires}`;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
    if (sig !== expected) return null;
    return email;
  } catch(e) {
    return null;
  }
}

export function middleware(request) {
  const { pathname } = request.nextUrl;

  // Diese Pfade brauchen KEIN Login
  if (
    pathname === '/login.html' ||
    pathname === '/' ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.includes('.css') ||
    pathname.includes('.js') ||
    pathname.includes('.png') ||
    pathname.includes('.ico') ||
    pathname.includes('.jpg') ||
    pathname.includes('.svg')
  ) {
    return NextResponse.next();
  }

  // Cookie prüfen
  const cookie = request.cookies.get('gastro_os_session');
  if (!cookie) {
    return NextResponse.redirect(new URL('/login.html', request.url));
  }

  const email = verifySession(cookie.value);
  if (!email) {
    return NextResponse.redirect(new URL('/login.html', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
