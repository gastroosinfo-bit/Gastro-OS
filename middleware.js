export function middleware(request) {
  const { pathname } = new URL(request.url);

  // Diese Pfade ohne Login erlauben
  if (
    pathname === '/login.html' ||
    pathname === '/' ||
    pathname.startsWith('/api/') ||
    pathname.endsWith('.css') ||
    pathname.endsWith('.js') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.ico') ||
    pathname.endsWith('.jpg') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.webp')
  ) {
    return;
  }

  // Cookie prüfen
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/gastro_os_session=([^;]+)/);

  if (!match) {
    return Response.redirect(new URL('/login.html', request.url));
  }

  return;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
