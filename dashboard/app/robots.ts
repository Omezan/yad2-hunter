import type { MetadataRoute } from 'next';

// The dashboard is publicly reachable (auth wall removed) so that
// non-technical recipients can open links without a login prompt.
// We do not want search engines surfacing the URL though — the page
// renders private apartment listings the user is actively tracking
// and routes like /api/trigger/scan should not be indexed at all.
//
// Honest crawlers (Google, Bing, DuckDuckGo) respect Disallow.
// Determined scrapers will ignore robots.txt; for those the only
// defense is that the URL itself is not advertised anywhere.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        disallow: '/'
      }
    ]
  };
}
