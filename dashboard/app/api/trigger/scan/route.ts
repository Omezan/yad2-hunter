import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKFLOW_FILE = 'scan-once.yml';

// Whitelist of search ids the API will forward to the workflow. Keep
// it in sync with src/config/searches.js — using a static list lets
// us reject unknown / empty values without a server import.
const KNOWN_SEARCH_IDS = new Set([
  'jerusalem',
  'center-sharon',
  'south',
  'coastal-north',
  'north-valleys'
]);

function sanitizeSearchIds(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const cleaned = raw
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value && KNOWN_SEARCH_IDS.has(value));
  // Deduplicate while preserving order.
  return Array.from(new Set(cleaned)).join(',');
}

export async function POST(request: Request) {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const branch = process.env.WORKFLOW_DISPATCH_REF || 'main';

  if (!repo || !token) {
    return NextResponse.json(
      { error: 'Missing GITHUB_REPO or GITHUB_TOKEN env var' },
      { status: 500 }
    );
  }

  // Body is optional — old clients that POST without one keep the
  // "scan everything" behaviour.
  let searchIdsCsv = '';
  try {
    const body = await request.json();
    searchIdsCsv = sanitizeSearchIds(body?.searchIds);
  } catch {
    // No JSON body → scan everything.
  }

  const dispatchedAt = new Date().toISOString();
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'yad2-hunter-dashboard'
    },
    body: JSON.stringify({
      ref: branch,
      inputs: { search_ids: searchIdsCsv }
    })
  });

  if (res.status === 204) {
    return NextResponse.json({
      ok: true,
      dispatchedAt,
      searchIds: searchIdsCsv ? searchIdsCsv.split(',') : [],
      message: searchIdsCsv
        ? `הסריקה הופעלה למחוזות: ${searchIdsCsv.replace(/,/g, ', ')}. תוצאות תוך כ-3 דקות.`
        : 'הסריקה הופעלה. תוצאות יופיעו תוך כ-3 דקות.'
    });
  }

  const detail = await res.text().catch(() => '');
  return NextResponse.json(
    {
      error: `GitHub API returned ${res.status}: ${detail.slice(0, 300)}`,
      hint:
        res.status === 403 || res.status === 404
          ? 'The PAT likely lacks Actions:Write permission on this repository.'
          : undefined
    },
    { status: 502 }
  );
}
