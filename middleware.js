export function middleware(request) {
  const { pathname } = new URL(request.url);

  if (pathname === '/login.html' || pathname.startsWith('/api/')) {
    return;
  }

  const cookieHeader = request.headers.get('cookie') || '';
  if (!cookieHeader.includes('gastro_os_session=')) {
    return Response.redirect(new URL('/login.html', request.url));
  }
}

export const config = {
  matcher: ['/modul:path*.html', '/dashboard.html'],
};
