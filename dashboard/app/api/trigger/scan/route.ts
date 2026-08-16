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
  'north-valleys',
  'lev-hapark-rent',
  'lev-hapark-sale',
  'rent-in-cities'
]);

function sanitizeSearchIds(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const cleaned = raw
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value && KNOWN_SEARCH_IDS.has(value));
  // Deduplicate while preserving order.
  return Array.from(new Set(cleaned)).join(',');
}

// Clamp the user-supplied budget to a sane rent range so a typo (or a
// malicious caller) can't push an absurd maxPrice into the Yad2 URL.
// Returns '' for missing/invalid input → the workflow keeps each
// search's default ceiling.
const MIN_BUDGET = 1000;
const MAX_BUDGET = 100000;

function sanitizeMaxPrice(raw: unknown): string {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw.trim(), 10)
        : NaN;
  if (!Number.isFinite(n)) return '';
  const clamped = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.round(n)));
  return String(clamped);
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
  // "scan everything" behaviour and each search's default budget.
  let searchIdsCsv = '';
  let maxPrice = '';
  try {
    const body = await request.json();
    searchIdsCsv = sanitizeSearchIds(body?.searchIds);
    maxPrice = sanitizeMaxPrice(body?.maxPrice);
  } catch {
    // No JSON body → scan everything with default budgets.
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
      inputs: { search_ids: searchIdsCsv, max_price: maxPrice }
    })
  });

  if (res.status === 204) {
    const budgetNote = maxPrice ? ` (תקציב עד ${Number(maxPrice).toLocaleString('he-IL')}₪)` : '';
    return NextResponse.json({
      ok: true,
      dispatchedAt,
      searchIds: searchIdsCsv ? searchIdsCsv.split(',') : [],
      maxPrice: maxPrice ? Number(maxPrice) : null,
      message: searchIdsCsv
        ? `הסריקה הופעלה למחוזות: ${searchIdsCsv.replace(/,/g, ', ')}${budgetNote}. תוצאות תוך כ-3 דקות.`
        : `הסריקה הופעלה${budgetNote}. תוצאות יופיעו תוך כ-3 דקות.`
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
