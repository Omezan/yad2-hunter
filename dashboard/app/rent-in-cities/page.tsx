'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AdCard from '../components/AdCard';
import FilterBar, {
  type FreshnessFilter,
  type PriceBounds,
  type SortKey,
  type TimeWindow,
  type ViewMode
} from '../components/FilterBar';
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

// Leaflet uses window/document on import — must be client-only,
// matching the home dashboard's MapView wiring.
const MapView = dynamic(() => import('../components/MapView'), {
  ssr: false,
  loading: () => <div className="notice notice-loading">טוען מפה…</div>
});

const VISIT_KEY = 'yad2-hunter-last-visit-at:rent-in-cities';
const WATCH_SEARCH_IDS = Array.from(RENT_IN_CITIES_SEARCH_IDS);

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

const UNKNOWN_CITY_KEY = '__unknown__';

export default function RentInCitiesPage() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState<number>(() => Date.now());
  const [searchParamSince, setSearchParamSince] = useState<string | null>(null);
  const [lastVisitAt, setLastVisitAt] = useState<string | null>(null);

  // Filter-bar state — mirrors the home dashboard exactly so the UX is
  // identical, but with "city" semantics in place of "district".
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('firstSeenDesc');
  const [selectedCities, setSelectedCities] = useState<Set<string>>(new Set());
  const [freshness, setFreshness] = useState<FreshnessFilter>('all');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('all');
  const [priceMin, setPriceMin] = useState<number | null>(null);
  const [priceMax, setPriceMax] = useState<number | null>(null);
  const [view, setView] = useState<ViewMode>('list');

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

  const effectiveSince = pickEffectiveSince(searchParamSince, lastVisitAt);

  // Only ads from the rent-in-cities watch show up on this page.
  const watchAds = useMemo(
    () => (data?.ads || []).filter((ad) => RENT_IN_CITIES_SEARCH_IDS.has(ad.searchId)),
    [data?.ads]
  );

  const freshAds = useMemo(
    () => watchAds.filter((ad) => isAdFresh(ad.firstSeenAt, effectiveSince)),
    [watchAds, effectiveSince]
  );

  // City options are derived from the actual ads on the page — same shape
  // FilterBar expects for districts, but keyed by the city string.
  const cityOptions = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const ad of watchAds) {
      const raw = (ad.city || '').trim();
      const key = raw || UNKNOWN_CITY_KEY;
      const label = raw || 'לא ידוע';
      const entry = map.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        map.set(key, { label, count: 1 });
      }
    }
    return Array.from(map.entries())
      .map(([value, info]) => ({ value, label: info.label, count: info.count }))
      .sort((a, b) => a.label.localeCompare(b.label, 'he'));
  }, [watchAds]);

  const priceBounds: PriceBounds | null = useMemo(() => {
    const prices: number[] = [];
    for (const ad of watchAds) {
      if (typeof ad.price === 'number' && Number.isFinite(ad.price) && ad.price > 0) {
        prices.push(ad.price);
      }
    }
    if (!prices.length) return null;
    const rawMin = Math.min(...prices);
    const rawMax = Math.max(...prices);
    const snappedMin = Math.floor(rawMin / 100) * 100;
    const snappedMax = Math.ceil(rawMax / 100) * 100;
    if (snappedMax <= snappedMin) {
      return { min: snappedMin, max: snappedMin + 100, step: 100 };
    }
    const span = snappedMax - snappedMin;
    const step = span >= 4000 ? 250 : 100;
    return { min: snappedMin, max: snappedMax, step };
  }, [watchAds]);

  // Re-clamp the user's chosen min/max when the dataset shifts.
  useEffect(() => {
    if (!priceBounds) return;
    if (priceMin !== null && (priceMin < priceBounds.min || priceMin > priceBounds.max)) {
      setPriceMin(null);
    }
    if (priceMax !== null && (priceMax < priceBounds.min || priceMax > priceBounds.max)) {
      setPriceMax(null);
    }
  }, [priceBounds, priceMin, priceMax]);

  const timeWindowSinceMs = useMemo(() => {
    if (timeWindow === 'all') return null;
    const DAY = 24 * 60 * 60 * 1000;
    const span =
      timeWindow === '24h' ? DAY : timeWindow === '7d' ? 7 * DAY : 30 * DAY;
    return now - span;
  }, [timeWindow, now]);

  const filteredAds = useMemo(() => {
    const lowerSearch = search.trim().toLowerCase();
    const effectiveMin = priceMin;
    const effectiveMax = priceMax;
    let result = watchAds.filter((ad) => {
      if (freshness === 'new' && !isAdFresh(ad.firstSeenAt, effectiveSince)) {
        return false;
      }
      if (timeWindowSinceMs !== null) {
        const ts = Date.parse(ad.firstSeenAt);
        if (Number.isNaN(ts) || ts < timeWindowSinceMs) return false;
      }
      if (selectedCities.size > 0) {
        const key = (ad.city || '').trim() || UNKNOWN_CITY_KEY;
        if (!selectedCities.has(key)) return false;
      }
      if (typeof ad.price === 'number' && Number.isFinite(ad.price)) {
        if (effectiveMin !== null && ad.price < effectiveMin) return false;
        if (effectiveMax !== null && ad.price > effectiveMax) return false;
      }
      if (lowerSearch) {
        const haystack = `${ad.title || ''} ${ad.city || ''}`.toLowerCase();
        if (!haystack.includes(lowerSearch)) return false;
      }
      return true;
    });

    result = [...result].sort((a, b) => {
      if (sort === 'priceAsc') {
        const ap = a.price ?? Number.POSITIVE_INFINITY;
        const bp = b.price ?? Number.POSITIVE_INFINITY;
        if (ap !== bp) return ap - bp;
      } else if (sort === 'roomsDesc') {
        const ar = a.rooms ?? -1;
        const br = b.rooms ?? -1;
        if (ar !== br) return br - ar;
      }
      const at = Date.parse(a.firstSeenAt) || 0;
      const bt = Date.parse(b.firstSeenAt) || 0;
      return bt - at;
    });

    return result;
  }, [
    watchAds,
    freshness,
    effectiveSince,
    timeWindowSinceMs,
    selectedCities,
    search,
    sort,
    priceMin,
    priceMax
  ]);

  const handleToggleCity = useCallback((value: string) => {
    setSelectedCities((prev) => {
      const next = new Set(prev);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  }, []);

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
          <FilterBar
            freshness={freshness}
            onFreshnessChange={setFreshness}
            search={search}
            onSearchChange={setSearch}
            sort={sort}
            onSortChange={setSort}
            districtOptions={cityOptions}
            selectedDistricts={selectedCities}
            onToggleDistrict={handleToggleCity}
            onClearDistricts={() => setSelectedCities(new Set())}
            hasFreshAds={freshAds.length > 0}
            priceBounds={priceBounds}
            priceMin={priceMin}
            priceMax={priceMax}
            onPriceMinChange={setPriceMin}
            onPriceMaxChange={setPriceMax}
            onPriceReset={() => {
              setPriceMin(null);
              setPriceMax(null);
            }}
            view={view}
            onViewChange={setView}
            totalCount={watchAds.length}
            timeWindow={timeWindow}
            onTimeWindowChange={setTimeWindow}
            categoryKey="city"
          />

          <div className="results-count">{filteredAds.length} תוצאות</div>

          {view === 'map' ? (
            <MapView ads={filteredAds} effectiveSince={effectiveSince} />
          ) : filteredAds.length === 0 ? (
            <div className="notice notice-empty">
              לא נמצאו מודעות התואמות את הסינון
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
