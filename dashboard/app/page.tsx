'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import AdCard from './components/AdCard';
import FilterBar, {
  type FreshnessFilter,
  type PriceBounds,
  type SortKey
} from './components/FilterBar';
import HealthCheckResultModal from './components/HealthCheckResultModal';
import ScanResultModal from './components/ScanResultModal';
import { useCompletionWatcher } from './hooks/useCompletionWatcher';
import { useTriggerWorkflow } from './hooks/useTriggerWorkflow';
import {
  formatHebrewDateTime,
  isAdFresh,
  pickEffectiveSince,
  readLastVisitAt,
  writeLastVisitAt
} from './lib/freshness';
import type { AdRow, LastRun, StateResponse } from './lib/types';

function getQueryParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

type ScanResult = {
  open: boolean;
  newAds: AdRow[];
  dispatchedAt: string | null;
  completedAt: string | null;
  /** Snapshot of effectiveSince at dispatch time, so "פתח בדאשבורד" matches the modal. */
  since: string | null;
};

type HealthResult = {
  open: boolean;
  dispatchedAt: string | null;
  completedAt: string | null;
};

export default function DashboardPage() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('firstSeenDesc');
  const [selectedDistricts, setSelectedDistricts] = useState<Set<string>>(new Set());
  const [searchParamSince, setSearchParamSince] = useState<string | null>(null);
  const [lastVisitAt, setLastVisitAt] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<FreshnessFilter>('all');
  const [priceMin, setPriceMin] = useState<number | null>(null);
  const [priceMax, setPriceMax] = useState<number | null>(null);

  // Pending dispatches (used by the completion watchers).
  const [scanDispatch, setScanDispatch] = useState<{ at: string; since: string | null } | null>(
    null
  );
  const [healthDispatch, setHealthDispatch] = useState<string | null>(null);

  // Modal results.
  const [scanResult, setScanResult] = useState<ScanResult>({
    open: false,
    newAds: [],
    dispatchedAt: null,
    completedAt: null,
    since: null
  });
  const [healthResult, setHealthResult] = useState<HealthResult>({
    open: false,
    dispatchedAt: null,
    completedAt: null
  });

  useEffect(() => {
    setSearchParamSince(getQueryParam('since'));
    setLastVisitAt(readLastVisitAt());
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

  const freshAds = useMemo(
    () => ads.filter((ad) => isAdFresh(ad.firstSeenAt, effectiveSince)),
    [ads, effectiveSince]
  );

  useEffect(() => {
    if (searchParamSince && freshAds.length > 0 && freshness === 'all') {
      setFreshness('new');
    }
  }, [searchParamSince, freshAds.length, freshness]);

  const districtOptions = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const ad of ads) {
      const key = ad.searchId || 'other';
      const label = ad.districtLabel || ad.searchLabel || key;
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
  }, [ads]);

  // Derive the [min, max] window from the actual prices we have on hand.
  // Snap bounds outwards to the nearest 100 ₪ so the slider feels nice.
  const priceBounds: PriceBounds | null = useMemo(() => {
    const prices: number[] = [];
    for (const ad of ads) {
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
    // Keep the slider snappy on small ranges, coarser on large ones.
    const step = span >= 4000 ? 250 : 100;
    return { min: snappedMin, max: snappedMax, step };
  }, [ads]);

  // Re-clamp the user's chosen min/max when the dataset shifts (e.g. after
  // a scan completes and brings in a cheaper or pricier ad).
  useEffect(() => {
    if (!priceBounds) return;
    if (priceMin !== null && (priceMin < priceBounds.min || priceMin > priceBounds.max)) {
      setPriceMin(null);
    }
    if (priceMax !== null && (priceMax < priceBounds.min || priceMax > priceBounds.max)) {
      setPriceMax(null);
    }
  }, [priceBounds, priceMin, priceMax]);

  const filteredAds = useMemo(() => {
    const lowerSearch = search.trim().toLowerCase();
    const effectiveMin = priceMin;
    const effectiveMax = priceMax;
    let result = ads.filter((ad) => {
      if (freshness === 'new' && !isAdFresh(ad.firstSeenAt, effectiveSince)) {
        return false;
      }
      if (selectedDistricts.size > 0 && !selectedDistricts.has(ad.searchId)) {
        return false;
      }
      // Price filter: ads without an explicit price are ALWAYS kept
      // visible (their price is unknown, not "outside the window").
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
  }, [ads, freshness, effectiveSince, selectedDistricts, search, sort, priceMin, priceMax]);

  const handleToggleDistrict = useCallback((value: string) => {
    setSelectedDistricts((prev) => {
      const next = new Set(prev);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  }, []);

  const handleMarkAllRead = useCallback(() => {
    const now = new Date().toISOString();
    writeLastVisitAt(now);
    setLastVisitAt(now);
    setSearchParamSince(null);
    if (typeof window !== 'undefined' && window.location.search) {
      const url = new URL(window.location.href);
      url.searchParams.delete('since');
      window.history.replaceState({}, '', url.toString());
    }
    setFreshness('all');
  }, []);

  const onScanDispatched = useCallback(
    (dispatchedAt: string) => {
      setScanDispatch({ at: dispatchedAt, since: effectiveSince });
    },
    [effectiveSince]
  );

  const onHealthDispatched = useCallback((dispatchedAt: string) => {
    setHealthDispatch(dispatchedAt);
  }, []);

  const scanTrigger = useTriggerWorkflow({
    endpoint: '/api/trigger/scan',
    onDispatched: onScanDispatched
  });
  const healthTrigger = useTriggerWorkflow({
    endpoint: '/api/trigger/health-check',
    onDispatched: onHealthDispatched
  });

  const onScanComplete = useCallback(
    ({ state, lastRun }: { state: StateResponse; lastRun: NonNullable<LastRun> }) => {
      const dispatch = scanDispatch;
      setScanDispatch(null);
      setData(state);
      const dispatchedAt = dispatch?.at || null;
      const since = dispatch?.since ?? null;
      const dispatchedMs = dispatchedAt ? Date.parse(dispatchedAt) : NaN;
      // Pick ads whose firstSeenAt advanced after the user clicked "הרץ סריקה",
      // falling back to whatever was already considered "fresh" if dispatch parse fails.
      const newAds = state.ads.filter((ad) => {
        const t = Date.parse(ad.firstSeenAt);
        if (Number.isNaN(t)) return false;
        if (!Number.isNaN(dispatchedMs) && t >= dispatchedMs) return true;
        return isAdFresh(ad.firstSeenAt, since);
      });
      newAds.sort((a, b) => {
        const at = Date.parse(a.firstSeenAt) || 0;
        const bt = Date.parse(b.firstSeenAt) || 0;
        return bt - at;
      });
      setScanResult({
        open: true,
        newAds,
        dispatchedAt,
        completedAt: lastRun.completedAt || lastRun.startedAt,
        since
      });
    },
    [scanDispatch]
  );

  useCompletionWatcher({
    dispatchedAt: scanDispatch?.at ?? null,
    onComplete: onScanComplete,
    onSnapshot: (snapshot) => setData(snapshot)
  });

  const onHealthComplete = useCallback(
    ({ state, lastRun }: { state: StateResponse; lastRun: NonNullable<LastRun> }) => {
      setHealthDispatch(null);
      setData(state);
      setHealthResult({
        open: true,
        dispatchedAt: healthDispatch,
        completedAt: lastRun.completedAt || lastRun.startedAt
      });
    },
    [healthDispatch]
  );

  useCompletionWatcher({
    dispatchedAt: healthDispatch,
    onComplete: onHealthComplete,
    onSnapshot: (snapshot) => setData(snapshot)
  });

  const handleShowScanInDashboard = useCallback(() => {
    const since = scanResult.since ?? scanResult.dispatchedAt;
    if (since) {
      setSearchParamSince(since);
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.set('since', since);
        window.history.replaceState({}, '', url.toString());
      }
    }
    setSelectedDistricts(new Set());
    setSearch('');
    setFreshness('new');
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [scanResult.dispatchedAt, scanResult.since]);

  const sinceLabel = formatHebrewDateTime(effectiveSince);
  const totalCount = ads.length;
  const generatedAt = data?.generatedAt ? formatHebrewDateTime(data.generatedAt) : null;

  const scanButtonLabel = (() => {
    if (scanTrigger.status === 'pending') return 'מפעיל…';
    if (scanDispatch) return 'סורק…';
    if (scanTrigger.cooldownSecondsLeft > 0) return `המתן ${scanTrigger.cooldownSecondsLeft}s`;
    return 'הרץ סריקה';
  })();
  const healthButtonLabel = (() => {
    if (healthTrigger.status === 'pending') return 'מפעיל…';
    if (healthDispatch) return 'בודק…';
    if (healthTrigger.cooldownSecondsLeft > 0) return `המתן ${healthTrigger.cooldownSecondsLeft}s`;
    return 'ודא אמינות';
  })();

  const banner = (() => {
    if (scanTrigger.status === 'error' && scanTrigger.message) {
      return { tone: 'error' as const, text: `סריקה: ${scanTrigger.message}` };
    }
    if (healthTrigger.status === 'error' && healthTrigger.message) {
      return { tone: 'error' as const, text: `בדיקה: ${healthTrigger.message}` };
    }
    if (scanDispatch) {
      return { tone: 'info' as const, text: 'הסריקה רצה ברקע. נודיע לך כשתסתיים…' };
    }
    if (healthDispatch) {
      return { tone: 'info' as const, text: 'הבדיקה רצה ברקע. נודיע לך כשתסתיים…' };
    }
    if (scanTrigger.status === 'success' && scanTrigger.message) {
      return { tone: 'success' as const, text: scanTrigger.message };
    }
    if (healthTrigger.status === 'success' && healthTrigger.message) {
      return { tone: 'success' as const, text: healthTrigger.message };
    }
    return null;
  })();

  return (
    <main className="layout">
      <header className="header">
        <div className="header-titles">
          <h1 className="brand">
            <span className="brand-icon" aria-hidden="true">🏡</span>
            <span>מציאת בית במושב</span>
          </h1>
          <div className="header-badges">
            {totalCount > 0 ? <span className="badge">{totalCount} מודעות במעקב</span> : null}
            {freshAds.length > 0 ? (
              <span className="badge badge-soft">
                {freshAds.length} חדשות{sinceLabel ? ` מאז ${sinceLabel}` : ''}
              </span>
            ) : null}
          </div>
          {generatedAt ? <span className="header-meta">עודכן {generatedAt}</span> : null}
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="primary"
            onClick={scanTrigger.trigger}
            disabled={scanTrigger.isDisabled || Boolean(scanDispatch)}
            title="מפעיל סריקה מיידית; תוצאות יופיעו כאן תוך כ-3 דקות"
          >
            {scanButtonLabel}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={healthTrigger.trigger}
            disabled={healthTrigger.isDisabled || Boolean(healthDispatch)}
            title="מפעיל בדיקת תקינות; הודעת Telegram + תוצאות בדאשבורד תוך כ-3 דקות"
          >
            {healthButtonLabel}
          </button>
          {freshAds.length > 0 ? (
            <button type="button" onClick={handleMarkAllRead}>
              סמן הכל כנקרא
            </button>
          ) : null}
        </div>
      </header>

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
            districtOptions={districtOptions}
            selectedDistricts={selectedDistricts}
            onToggleDistrict={handleToggleDistrict}
            onClearDistricts={() => setSelectedDistricts(new Set())}
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
          />

          <div className="results-count">{filteredAds.length} תוצאות</div>

          {filteredAds.length === 0 ? (
            <div className="notice notice-empty">לא נמצאו מודעות התואמות את הסינון</div>
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

      <ScanResultModal
        open={scanResult.open}
        onClose={() => setScanResult((prev) => ({ ...prev, open: false }))}
        newAds={scanResult.newAds}
        dispatchedAt={scanResult.dispatchedAt}
        completedAt={scanResult.completedAt}
        onShowInDashboard={handleShowScanInDashboard}
      />

      <HealthCheckResultModal
        open={healthResult.open}
        onClose={() => setHealthResult((prev) => ({ ...prev, open: false }))}
        dispatchedAt={healthResult.dispatchedAt}
        completedAt={healthResult.completedAt}
      />
    </main>
  );
}
