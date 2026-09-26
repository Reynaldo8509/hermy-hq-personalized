import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // DEV-ONLY local bypass (never active on Vercel preview/prod builds).
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.next();
  }

  // Skip auth for NextAuth routes, assets, login, and public embeddable charts
  if (
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/garden') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon.ico') ||
    pathname === '/login'
  ) {
    return NextResponse.next();
  }

  // Allow internal agent calls with shared secret
  const internalSecret = request.headers.get('x-internal-secret');
  if (internalSecret && internalSecret === process.env.INTERNAL_API_SECRET) {
    return NextResponse.next();
  }

  // Check NextAuth JWT session
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
