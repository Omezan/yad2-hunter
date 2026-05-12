'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AdCard from '../components/AdCard';
import { useCompletionWatcher } from '../hooks/useCompletionWatcher';
import { useTriggerWorkflow } from '../hooks/useTriggerWorkflow';
import {
  formatHebrewDateTime,
  formatHebrewRelative,
  isAdFresh,
  pickEffectiveSince,
  readLastVisitAt,
  writeLastVisitAt
} from '../lib/freshness';
import { LEV_HAPARK_SEARCH_IDS } from '../lib/lev-hapark';
import type { AdRow, LastRun, StateResponse } from '../lib/types';

type Mode = 'all' | 'rent' | 'sale';

const MODES: { value: Mode; label: string }[] = [
  { value: 'all', label: 'הכל' },
  { value: 'rent', label: 'שכירות' },
  { value: 'sale', label: 'מכירה' }
];

const VISIT_KEY = 'yad2-hunter-last-visit-at:lev-hapark';

function readLevLastVisit(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(VISIT_KEY);
  } catch {
    return null;
  }
}

function writeLevLastVisit(value: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VISIT_KEY, value);
  } catch {
    /* ignore */
  }
}

function getQueryParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

export default function LevHaParkPage() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>('all');
  const [now, setNow] = useState<number>(() => Date.now());
  const [searchParamSince, setSearchParamSince] = useState<string | null>(null);
  const [lastVisitAt, setLastVisitAt] = useState<string | null>(null);

  const [scanDispatch, setScanDispatch] = useState<{ at: string; since: string | null } | null>(
    null
  );

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setSearchParamSince(getQueryParam('since'));
    setLastVisitAt(readLevLastVisit() || readLastVisitAt());
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/state', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
        }
        return res.json() as Promise<StateResponse>;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ads = data?.ads || [];
  const effectiveSince = pickEffectiveSince(searchParamSince, lastVisitAt);

  // Only ads from the two Lev HaPark searches show up on this page.
  const watchAds = useMemo(
    () => ads.filter((ad) => LEV_HAPARK_SEARCH_IDS.has(ad.searchId)),
    [ads]
  );

  const filteredAds = useMemo(() => {
    let result = watchAds;
    if (mode === 'rent') {
      result = result.filter((ad) => ad.searchId === 'lev-hapark-rent');
    } else if (mode === 'sale') {
      result = result.filter((ad) => ad.searchId === 'lev-hapark-sale');
    }
    return [...result].sort((a, b) => {
      const at = Date.parse(a.firstSeenAt) || 0;
      const bt = Date.parse(b.firstSeenAt) || 0;
      return bt - at;
    });
  }, [watchAds, mode]);

  const countsByMode = useMemo(() => {
    let rent = 0;
    let sale = 0;
    for (const ad of watchAds) {
      if (ad.searchId === 'lev-hapark-rent') rent += 1;
      else if (ad.searchId === 'lev-hapark-sale') sale += 1;
    }
    return { all: watchAds.length, rent, sale };
  }, [watchAds]);

  const freshAds = useMemo(
    () => watchAds.filter((ad) => isAdFresh(ad.firstSeenAt, effectiveSince)),
    [watchAds, effectiveSince]
  );

  const onScanDispatched = useCallback(
    (dispatchedAt: string) => {
      setScanDispatch({ at: dispatchedAt, since: effectiveSince });
    },
    [effectiveSince]
  );

  const scanTrigger = useTriggerWorkflow({
    endpoint: '/api/trigger/scan',
    onDispatched: onScanDispatched
  });

  const onScanComplete = useCallback(
    ({ state, lastRun }: { state: StateResponse; lastRun: NonNullable<LastRun> }) => {
      setScanDispatch(null);
      setData(state);
      // Reset the "new" baseline so manual scan results are visible
      // immediately in the cards (the ribbon).
      void lastRun;
    },
    []
  );

  useCompletionWatcher({
    dispatchedAt: scanDispatch?.at ?? null,
    onComplete: onScanComplete,
    onSnapshot: (snapshot) => setData(snapshot)
  });

  const lastRun = data?.lastScan ?? data?.lastRun ?? null;
  const lastRunRef = lastRun?.completedAt || lastRun?.startedAt || null;
  const lastRunRelative = formatHebrewRelative(lastRunRef, now);
  const lastRunAbsolute = formatHebrewDateTime(lastRunRef);

  const handleMarkRead = useCallback(() => {
    const ts = new Date().toISOString();
    writeLevLastVisit(ts);
    writeLastVisitAt(ts);
    setLastVisitAt(ts);
    setSearchParamSince(null);
    if (typeof window !== 'undefined' && window.location.search) {
      const url = new URL(window.location.href);
      url.searchParams.delete('since');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  const scanButtonLabel = (() => {
    if (scanTrigger.status === 'pending') return 'מפעיל…';
    if (scanDispatch) return 'סורק…';
    if (scanTrigger.cooldownSecondsLeft > 0) return `המתן ${scanTrigger.cooldownSecondsLeft}s`;
    return 'הרץ סריקה';
  })();

  const banner = (() => {
    if (scanTrigger.status === 'error' && scanTrigger.message) {
      return { tone: 'error' as const, text: `סריקה: ${scanTrigger.message}` };
    }
    if (scanDispatch) {
      return { tone: 'info' as const, text: 'הסריקה רצה ברקע. נודיע לך כשתסתיים…' };
    }
    if (scanTrigger.status === 'success' && scanTrigger.message) {
      return { tone: 'success' as const, text: scanTrigger.message };
    }
    return null;
  })();

  return (
    <main className="layout lev-layout">
      <header className="header lev-header">
        <div className="header-info">
          <Link href="/" className="lev-back">
            ← לכל המודעות
          </Link>
          {freshAds.length > 0 ? (
            <span className="badge badge-soft" style={{ marginInlineStart: 8 }}>
              {freshAds.length} חדשות
            </span>
          ) : null}
        </div>
        <div className="header-brand">
          <h1 className="brand">
            <span className="brand-icon" aria-hidden="true">🌳</span>
            <span>לב הפארק, רעננה</span>
            <span className="brand-icon" aria-hidden="true">🌳</span>
          </h1>
        </div>
        <div className="header-actions">
          <button
            type="button"
            onClick={() =>
              scanTrigger.trigger({
                searchIds: ['lev-hapark-rent', 'lev-hapark-sale']
              })
            }
            disabled={scanTrigger.isDisabled || Boolean(scanDispatch)}
            title="מפעיל סריקה ייעודית עבור לב הפארק (שכירות + מכירה)"
          >
            {scanButtonLabel}
          </button>
          {freshAds.length > 0 ? (
            <button type="button" className="secondary" onClick={handleMarkRead}>
              סמן כנקרא
            </button>
          ) : null}
        </div>
      </header>

      <div className="runs-status runs-status-row" aria-label="סטטוס ריצה">
        <span
          className={`runs-status-pill${
            lastRun?.status === 'failed' ? ' is-failed' : ''
          }`}
          title="סריקה אחרונה (כללית או ייעודית)"
        >
          <span className="runs-status-dot" aria-hidden="true" />
          <span className="runs-status-label">סריקה אחרונה:</span>
          <span className="runs-status-value">{lastRunAbsolute ?? '—'}</span>
          {lastRunRelative ? (
            <span className="runs-status-relative">· {lastRunRelative}</span>
          ) : null}
        </span>
      </div>

      {banner ? <div className={`notice notice-${banner.tone}`}>{banner.text}</div> : null}

      {loading ? <div className="notice notice-loading">טוען נתונים…</div> : null}
      {error ? (
        <div className="notice notice-error">שגיאה בטעינת הנתונים: {error}</div>
      ) : null}

      {!loading && !error ? (
        <>
          <div className="filter-toolbar lev-toolbar" role="toolbar" aria-label="סינון">
            <div className="segmented" role="tablist" aria-label="סוג עסקה">
              {MODES.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="tab"
                  aria-selected={mode === opt.value}
                  className={`segmented-option ${mode === opt.value ? 'is-active' : ''}`}
                  onClick={() => setMode(opt.value)}
                >
                  {opt.label}
                  <span className="lev-toolbar-count">
                    {opt.value === 'all'
                      ? countsByMode.all
                      : opt.value === 'rent'
                        ? countsByMode.rent
                        : countsByMode.sale}
                  </span>
                </button>
              ))}
            </div>

            <div className="toolbar-count-badge badge badge-soft">
              {filteredAds.length.toLocaleString('he-IL')} תוצאות
            </div>
          </div>

          {filteredAds.length === 0 ? (
            <div className="notice notice-empty">
              עדיין אין מודעות שזוהו בלב הפארק. נסה להפעיל סריקה ייעודית.
            </div>
          ) : (
            <div className="grid">
              {filteredAds.map((ad) => (
                <AdCard
                  key={ad.externalId}
                  ad={ad}
                  isNew={isAdFresh(ad.firstSeenAt, effectiveSince)}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </main>
  );
}
