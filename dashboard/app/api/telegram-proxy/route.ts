import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const proxySecret = process.env.TELEGRAM_PROXY_SECRET;

  if (!botToken) {
    return NextResponse.json(
      { error: 'Missing TELEGRAM_BOT_TOKEN env var' },
      { status: 500 }
    );
  }

  const authHeader = request.headers.get('authorization');
  if (!proxySecret || authHeader !== `Bearer ${proxySecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { chat_id, text, parse_mode, disable_web_page_preview } = body;
  if (!chat_id || !text) {
    return NextResponse.json(
      { error: 'Missing chat_id or text' },
      { status: 400 }
    );
  }

  const payload: Record<string, unknown> = { chat_id, text };
  if (parse_mode) payload.parse_mode = parse_mode;
  if (disable_web_page_preview) payload.disable_web_page_preview = true;

  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }
  );

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return NextResponse.json(
      { error: 'Telegram API error', status: res.status, detail: data },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, result: data });
}
