import { NextRequest, NextResponse } from 'next/server';

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'
  ]
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function decodeBasicAuth(header: string): { user: string; pass: string } | null {
  if (!header.toLowerCase().startsWith('basic ')) return null;
  const encoded = header.slice(6).trim();
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return {
    user: decoded.slice(0, idx),
    pass: decoded.slice(idx + 1)
  };
}

export function middleware(req: NextRequest) {
  const expectedUser = process.env.DASHBOARD_USERNAME || '';
  const expectedPass = process.env.DASHBOARD_PASSWORD || '';

  if (!expectedUser || !expectedPass) {
    return new NextResponse(
      'Dashboard auth is not configured. Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD.',
      { status: 503 }
    );
  }

  const header = req.headers.get('authorization') || '';
  const creds = decodeBasicAuth(header);

  if (
    creds &&
    timingSafeEqual(creds.user, expectedUser) &&
    timingSafeEqual(creds.pass, expectedPass)
  ) {
    return NextResponse.next();
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Yad2 Hunter Dashboard", charset="UTF-8"'
    }
  });
}
