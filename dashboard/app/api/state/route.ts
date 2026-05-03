import { NextResponse } from 'next/server';
import type { AdRow, LastRun, RunSummary, StateResponse } from '../../lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SeenAdRecord = {
  externalId?: string;
  title?: string;
  link?: string;
  searchId?: string;
  searchLabel?: string | null;
  districtLabel?: string | null;
  price?: number | null;
  rooms?: number | null;
  city?: string | null;
  firstSeenAt?: string;
  lastSeenAt?: string;
};

type SeenAdsFile = { ads?: Record<string, SeenAdRecord> };

type RunEntry = {
  kind?: string;
  startedAt?: string;
  completedAt?: string;
  status?: string;
  trigger?: string;
  relevantNewAds?: number;
  totalAds?: number;
  allMatch?: boolean;
};

type RunsFile = { runs?: RunEntry[] };

type RunKind = 'scan' | 'health-check';

// Legacy runs.json entries (recorded before we tagged each run with
// `kind`) carry health-check-only fields like `allMatch` or scan-only
// fields like `relevantNewAds`. Use those as a fallback classifier so
// the dashboard works against pre-existing data.
function classifyRun(run: RunEntry): RunKind | null {
  if (run.kind === 'scan' || run.kind === 'health-check') return run.kind;
  if (typeof run.allMatch === 'boolean') return 'health-check';
  if (
    typeof run.relevantNewAds === 'number' ||
    typeof run.totalAds === 'number'
  ) {
    return 'scan';
  }
  return null;
}

function summarizeRun(run: RunEntry | undefined): RunSummary {
  if (!run || !run.startedAt) return null;
  return {
    startedAt: run.startedAt,
    completedAt: run.completedAt || null,
    status: run.status || null,
    trigger: run.trigger || null
  };
}

async function fetchJsonFromState<T>(filename: string): Promise<T | null> {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.STATE_BRANCH || 'state';
  const token = process.env.GITHUB_TOKEN;

  if (!repo || !token) {
    throw new Error('Missing GITHUB_REPO or GITHUB_TOKEN env var');
  }

  const url = `https://api.github.com/repos/${repo}/contents/${filename}?ref=${branch}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw',
      'User-Agent': 'yad2-hunter-dashboard'
    },
    cache: 'no-store'
  });

  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub API ${filename} ${res.status}: ${detail.slice(0, 200)}`);
  }

  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `Could not parse ${filename}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function normalizeAds(seen: SeenAdsFile | null): AdRow[] {
  if (!seen || !seen.ads) return [];
  const rows: AdRow[] = [];
  for (const [externalId, record] of Object.entries(seen.ads)) {
    if (!record) continue;
    rows.push({
      externalId: record.externalId || externalId,
      title: record.title || '',
      link: record.link || '',
      searchId: record.searchId || '',
      searchLabel: record.searchLabel ?? null,
      districtLabel: record.districtLabel ?? null,
      price: typeof record.price === 'number' ? record.price : null,
      rooms: typeof record.rooms === 'number' ? record.rooms : null,
      city: record.city ?? null,
      firstSeenAt: record.firstSeenAt || record.lastSeenAt || '',
      lastSeenAt: record.lastSeenAt || record.firstSeenAt || ''
    });
  }
  return rows;
}

function pickLastRun(runsFile: RunsFile | null): LastRun {
  if (!runsFile || !runsFile.runs || !runsFile.runs.length) return null;
  const top = runsFile.runs[0];
  if (!top || !top.startedAt) return null;
  return {
    startedAt: top.startedAt,
    completedAt: top.completedAt,
    status: top.status,
    relevantNewAds: top.relevantNewAds,
    totalAds: top.totalAds
  };
}

function pickLastByKind(runsFile: RunsFile | null, kind: RunKind): RunSummary {
  if (!runsFile || !runsFile.runs) return null;
  for (const run of runsFile.runs) {
    if (classifyRun(run) === kind) {
      return summarizeRun(run);
    }
  }
  return null;
}

export async function GET() {
  try {
    const [seen, runs] = await Promise.all([
      fetchJsonFromState<SeenAdsFile>('seen-ads.json'),
      fetchJsonFromState<RunsFile>('runs.json')
    ]);

    const payload: StateResponse = {
      ads: normalizeAds(seen),
      lastRun: pickLastRun(runs),
      lastScan: pickLastByKind(runs, 'scan'),
      lastHealthCheck: pickLastByKind(runs, 'health-check'),
      generatedAt: new Date().toISOString()
    };

    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
