import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { isTrustedOperatorPath } from '@/lib/trusted-operator.mjs';
import { authorizeJobApplyEventsToken } from '@/lib/job-apply-events-auth.mjs';
import { internalSecretMatches } from '@/lib/internal-secret-auth.mjs';
import { authorizeMcpRestartRequest, isMcpRestartCredentialPath } from '@/lib/mcp-restart-service-auth.mjs';

const INTERNAL_API_ROUTES: Array<{ method: string; path: string; nested?: boolean }> = [
  { method: "POST", path: "/api/agents" },
  { method: "GET", path: "/api/agents" },
  { method: "POST", path: "/api/agent-bus" },
  { method: "POST", path: "/api/cache/clear" },
  { method: "POST", path: "/api/codex/health" },
  { method: "GET", path: "/api/codex/tasks" },
  { method: "GET", path: "/api/codex/tasks", nested: true },
  { method: "GET", path: "/api/hermes/activity" },
  { method: "GET", path: "/api/hermes/health" },
  { method: "PATCH", path: "/api/codex/tasks", nested: true },
  { method: "GET", path: "/api/hermes/dispatch" },
  { method: "POST", path: "/api/hermes/dispatch" },
  { method: "GET", path: "/api/hermes/incident-memory" },
  { method: "GET", path: "/api/hermes/memory" },
  { method: "POST", path: "/api/hermes/crons" },
  { method: "GET", path: "/api/hermes/requests" },
  { method: "GET", path: "/api/milo/access-token" },
  { method: "POST", path: "/api/milo/access-token" },
  { method: "POST", path: "/api/milo/report" },
  { method: "POST", path: "/api/trends/snipe" },
  { method: "POST", path: "/api/trends/update" },
  { method: "POST", path: "/api/watchlist-radar/update" },
  { method: "POST", path: "/api/x-content" },
  { method: "POST", path: "/api/youtube/ideas" },
];

function permitsInternalApi(request: NextRequest, pathname: string) {
  return INTERNAL_API_ROUTES.some((route) =>
    route.method === request.method &&
    (pathname === route.path || (route.nested === true && pathname.startsWith(route.path + "/")))
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // DEV-ONLY local bypass (never active on Vercel preview/prod builds).
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.next();
  }

  // The signed hardware collector authenticates independently with its per-node Ed25519 key.
  if (pathname === '/api/infrastructure/telemetry' && request.method === 'POST') {
    return NextResponse.next();
  }

  // These exact methods/paths authenticate with a persistent Ed25519 operator key
  // inside their handlers; all unrecognized API paths still require a human session.
  if (isTrustedOperatorPath(request.method, pathname)) {
    return NextResponse.next();
  }

  // Skip auth for NextAuth routes, assets, login, and public embeddable charts
  if (
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon.ico') ||
    pathname === '/login'
  ) {
    return NextResponse.next();
  }

  // Dedicated publisher identity may access only the exact Job-Apply event endpoint.
  if (pathname === '/api/job-apply/events') {
    const authorization = authorizeJobApplyEventsToken(
      request.headers.get('x-job-apply-token'),
    );
    if (authorization.status !== 200) {
      return NextResponse.json({ error: authorization.error }, { status: authorization.status });
    }
    if (request.method !== 'POST') {
      return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
    }
    return NextResponse.next();
  }

  // This dedicated identity is limited to MCP restart request creation and status.
  // Supplying its header never falls through to a broader service or browser identity.
  if (request.headers.has('x-mcp-restart-token') || isMcpRestartCredentialPath(pathname)) {
    const authorization = authorizeMcpRestartRequest(
      request.method,
      request.url,
      request.headers.get('x-mcp-restart-token'),
    );
    if (authorization.status !== 200) {
      return NextResponse.json({ error: authorization.error }, { status: authorization.status });
    }
    return NextResponse.next();
  }

  // Internal credentials may bypass the browser session only on service routes
  // whose handlers perform their own constant-time shared-secret or actor check.
  const internalSecret = request.headers.get('x-internal-secret');
  if (internalSecretMatches(internalSecret, process.env.INTERNAL_API_SECRET) && permitsInternalApi(request, pathname)) {
    return NextResponse.next();
  }

  // Require both a valid session and a currently allowlisted human identity.
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const email = String(token.email || '').trim().toLowerCase();
  const allowedEmails = (process.env.ALLOWED_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowedEmails.includes(email)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.redirect(new URL('/login?error=AccessDenied', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
