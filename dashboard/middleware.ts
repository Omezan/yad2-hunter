import { NextResponse } from 'next/server';

// Auth wall intentionally disabled. The dashboard runs publicly so
// non-technical recipients (e.g. the Lev HaPark email recipient) can
// open the link without a Basic-Auth prompt.
//
// Re-enabling instructions: revert this file to the version in
// git history before commit `<auth-removed>`. The previous logic
// (HTTP Basic Auth via DASHBOARD_USERNAME / DASHBOARD_PASSWORD env
// vars and a `Basic realm="Yad2 Hunter Dashboard"` challenge) is
// preserved in git so it can be restored with a one-line file
// checkout.
//
// What's still safe with the wall off:
//   - The Telegram bot token, SMTP creds, and GitHub PAT live in
//     server-side env vars and are never sent to the browser.
//   - /api/state proxies a read-only PAT scoped to this repo's
//     `state` branch only.
// What's NOT safe with the wall off:
//   - /api/trigger/scan and /api/trigger/health-check are reachable
//     by anyone who guesses the URL. Mitigation chosen: robots.txt
//     disallow-all so crawlers don't index the site. If abuse shows
//     up we'll move trigger gating into the route handlers
//     themselves.

export const config = {
  // Empty matcher → Next.js skips this middleware on every route.
  matcher: []
};

export function middleware() {
  return NextResponse.next();
}
