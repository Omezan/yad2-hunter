import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKFLOW_FILE = 'scan-once.yml';

export async function POST() {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const branch = process.env.WORKFLOW_DISPATCH_REF || 'main';

  if (!repo || !token) {
    return NextResponse.json(
      { error: 'Missing GITHUB_REPO or GITHUB_TOKEN env var' },
      { status: 500 }
    );
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
    body: JSON.stringify({ ref: branch })
  });

  if (res.status === 204) {
    return NextResponse.json({
      ok: true,
      dispatchedAt,
      message: 'הסריקה הופעלה. תוצאות יופיעו תוך כ-3 דקות.'
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
