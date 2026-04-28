'use client';

import { useEffect, useMemo, useState } from 'react';
import AdCard from './components/AdCard';
import FilterBar, {
  type FreshnessFilter,
  type SortKey
} from './components/FilterBar';
import {
  formatHebrewDateTime,
  isAdFresh,
  pickEffectiveSince,
  readLastVisitAt,
  writeLastVisitAt
} from './lib/freshness';
import type { AdRow, StateResponse } from './lib/types';

function getQueryParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

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

  const filteredAds = useMemo(() => {
    const lowerSearch = search.trim().toLowerCase();
    let result = ads.filter((ad) => {
      if (freshness === 'new' && !isAdFresh(ad.firstSeenAt, effectiveSince)) {
        return false;
      }
      if (selectedDistricts.size > 0 && !selectedDistricts.has(ad.searchId)) {
        return false;
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
  }, [ads, freshness, effectiveSince, selectedDistricts, search, sort]);

  const handleToggleDistrict = (value: string) => {
    setSelectedDistricts((prev) => {
      const next = new Set(prev);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  };

  const handleMarkAllRead = () => {
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
  };

  const sinceLabel = formatHebrewDateTime(effectiveSince);
  const totalCount = ads.length;
  const generatedAt = data?.generatedAt ? formatHebrewDateTime(data.generatedAt) : null;

  return (
    <main className="layout">
      <header className="header">
        <h1>Yad2 Hunter</h1>
        {totalCount > 0 ? <span className="badge">{totalCount} מודעות במעקב</span> : null}
        {freshAds.length > 0 ? (
          <span className="badge" style={{ background: 'transparent' }}>
            {freshAds.length} חדשות{sinceLabel ? ` מאז ${sinceLabel}` : ''}
          </span>
        ) : null}
        <div className="meta">
          {generatedAt ? <span>עודכן {generatedAt}</span> : null}
          {freshAds.length > 0 ? (
            <button type="button" onClick={handleMarkAllRead}>
              סמן הכל כנקרא
            </button>
          ) : null}
        </div>
      </header>

      {loading ? <div className="loading">טוען נתונים…</div> : null}
      {error ? <div className="error">שגיאה בטעינת הנתונים: {error}</div> : null}

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
          />

          <div className="results-count">{filteredAds.length} תוצאות</div>

          {filteredAds.length === 0 ? (
            <div className="empty">לא נמצאו מודעות התואמות את הסינון</div>
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
