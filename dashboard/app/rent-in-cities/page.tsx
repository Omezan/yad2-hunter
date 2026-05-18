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
import { RENT_IN_CITIES_SEARCH_IDS } from '../lib/rent-in-cities';
import type { LastRun, StateResponse } from '../lib/types';

const VISIT_KEY = 'yad2-hunter-last-visit-at:rent-in-cities';

function readWatchLastVisit(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(VISIT_KEY);
  } catch {
    return null;
  }
}

function writeWatchLastVisit(value: string) {
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

const WATCH_SEARCH_IDS = Array.from(RENT_IN_CITIES_SEARCH_IDS);

export default function RentInCitiesPage() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
    setLastVisitAt(readWatchLastVisit() || readLastVisitAt());
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

  // Only ads from the rent-in-cities watch show up on this page.
  const watchAds = useMemo(
    () => ads.filter((ad) => RENT_IN_CITIES_SEARCH_IDS.has(ad.searchId)),
    [ads]
  );

  const filteredAds = useMemo(() => {
    return [...watchAds].sort((a, b) => {
      const at = Date.parse(a.firstSeenAt) || 0;
      const bt = Date.parse(b.firstSeenAt) || 0;
      return bt - at;
    });
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
    writeWatchLastVisit(ts);
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
    <main className="layout ric-layout">
      <header className="header ric-header">
        <div className="header-info">
          <Link href="/" className="ric-back">
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
            <span className="brand-icon" aria-hidden="true">🏙️</span>
            <span>שכירות בערים — מרכז ושרון</span>
            <span className="brand-icon" aria-hidden="true">🏙️</span>
          </h1>
        </div>
        <div className="header-actions">
          <button
            type="button"
            onClick={() =>
              scanTrigger.trigger({
                searchIds: WATCH_SEARCH_IDS
              })
            }
            disabled={scanTrigger.isDisabled || Boolean(scanDispatch)}
            title="מפעיל סריקה ייעודית לשכירות בערים"
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
          <div className="filter-toolbar ric-toolbar" role="toolbar" aria-label="סינון">
            <div className="toolbar-count-badge badge badge-soft">
              {filteredAds.length.toLocaleString('he-IL')} תוצאות
            </div>
          </div>

          {filteredAds.length === 0 ? (
            <div className="notice notice-empty">
              עדיין אין מודעות שזוהו בערים. נסה להפעיל סריקה ייעודית.
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
