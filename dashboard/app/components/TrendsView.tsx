'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdRow } from '../lib/types';
import {
  bucketByTime,
  chooseBucket,
  kpis,
  perDistrictTrend,
  pickRange,
  pricesHistogram,
  roomsDistribution,
  topCities,
  type Granularity,
  type RangeKey
} from '../lib/trends';
import { solidPillStyle } from '../lib/district-colors';
import TrendKpis from './trends/TrendKpis';
import VolumeTimeSeries from './trends/VolumeTimeSeries';
import DistrictSmallMultiples from './trends/DistrictSmallMultiples';
import PriceHistogram from './trends/PriceHistogram';
import PriceRoomsScatter from './trends/PriceRoomsScatter';
import TopCitiesTable from './trends/TopCitiesTable';
import RoomsBars from './trends/RoomsBars';

type DistrictOption = {
  value: string;
  label: string;
  count: number;
};

type Props = {
  ads: AdRow[];
  districtOptions: DistrictOption[];
  now: number;
};

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: '7d', label: '7 ימים' },
  { value: '30d', label: 'חודש' },
  { value: '90d', label: '3 חודשים' },
  { value: '365d', label: 'שנה' },
  { value: 'all', label: 'הכל' }
];

const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: 'auto', label: 'אוטומטי' },
  { value: 'day', label: 'יומי' },
  { value: 'week', label: 'שבועי' },
  { value: 'month', label: 'חודשי' }
];

export default function TrendsView({ ads, districtOptions, now }: Props) {
  const [range, setRange] = useState<RangeKey>('30d');
  const [granularity, setGranularity] = useState<Granularity>('auto');
  const [selectedDistricts, setSelectedDistricts] = useState<Set<string>>(new Set());
  const [districtOpen, setDistrictOpen] = useState(false);
  const districtRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!districtOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!districtRef.current) return;
      if (districtRef.current.contains(e.target as Node)) return;
      setDistrictOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDistrictOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [districtOpen]);

  const filteredAds = useMemo(() => {
    const inRange = pickRange(ads, range, now);
    if (selectedDistricts.size === 0) return inRange;
    return inRange.filter((ad) => selectedDistricts.has(ad.searchId));
  }, [ads, range, now, selectedDistricts]);

  const bucket = useMemo(
    () => chooseBucket(range, granularity),
    [range, granularity]
  );

  const series = useMemo(
    () => bucketByTime(filteredAds, bucket, (ad) => ad.searchId || 'other', { range, now }),
    [filteredAds, bucket, range, now]
  );

  const districtsForChart = useMemo(() => {
    const ids = new Set<string>();
    for (const ad of filteredAds) ids.add(ad.searchId || 'other');
    return districtOptions
      .filter((opt) => ids.has(opt.value))
      .map((opt) => ({ id: opt.value, label: opt.label }));
  }, [filteredAds, districtOptions]);

  const districtTrend = useMemo(
    () => perDistrictTrend(filteredAds, bucket, { range, now }),
    [filteredAds, bucket, range, now]
  );

  const kpiData = useMemo(() => kpis(filteredAds, now), [filteredAds, now]);

  const histogramData = useMemo(() => pricesHistogram(filteredAds), [filteredAds]);

  const cities = useMemo(() => topCities(filteredAds, 10), [filteredAds]);

  const rooms = useMemo(() => roomsDistribution(filteredAds), [filteredAds]);

  const toggleDistrict = (value: string) => {
    setSelectedDistricts((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const districtSummary = (() => {
    if (selectedDistricts.size === 0) return 'הכל';
    if (selectedDistricts.size === 1) {
      const onlyValue = Array.from(selectedDistricts)[0];
      const match = districtOptions.find((o) => o.value === onlyValue);
      return match ? match.label : onlyValue;
    }
    return `${selectedDistricts.size} נבחרו`;
  })();

  return (
    <div className="trends-root">
      <div className="trends-toolbar" role="toolbar" aria-label="בקרי טרנדים">
        <div className="trends-toolbar-group">
          <span className="trends-toolbar-label">טווח</span>
          <div className="segmented" role="tablist" aria-label="טווח זמן">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="tab"
                aria-selected={range === opt.value}
                className={`segmented-option ${range === opt.value ? 'is-active' : ''}`}
                onClick={() => setRange(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="trends-toolbar-group">
          <span className="trends-toolbar-label">פירוט</span>
          <div className="segmented" role="tablist" aria-label="פירוט זמן">
            {GRANULARITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="tab"
                aria-selected={granularity === opt.value}
                className={`segmented-option ${granularity === opt.value ? 'is-active' : ''}`}
                onClick={() => setGranularity(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div
          ref={districtRef}
          className={`toolbar-district ${districtOpen ? 'is-open' : ''}`}
        >
          <button
            type="button"
            className={`toolbar-district-button ${
              selectedDistricts.size > 0 ? 'has-selection' : ''
            }`}
            aria-haspopup="listbox"
            aria-expanded={districtOpen}
            onClick={() => setDistrictOpen((v) => !v)}
          >
            <span>מחוז: {districtSummary}</span>
            {selectedDistricts.size > 0 ? (
              <span className="toolbar-district-count">{selectedDistricts.size}</span>
            ) : null}
            <span className="toolbar-district-caret" aria-hidden="true">▾</span>
          </button>
          {districtOpen ? (
            <>
              <div
                className="toolbar-district-backdrop"
                aria-hidden="true"
                onClick={() => setDistrictOpen(false)}
              />
              <div className="toolbar-district-popover" role="dialog" aria-modal="true">
                <div className="toolbar-district-header">
                  <span className="toolbar-district-title">בחירת מחוז</span>
                  <button
                    type="button"
                    className="toolbar-district-close"
                    aria-label="סגור"
                    onClick={() => setDistrictOpen(false)}
                  >
                    ✕
                  </button>
                </div>
                <div className="toolbar-district-actions">
                  <button
                    type="button"
                    className="toolbar-district-link"
                    onClick={() => setSelectedDistricts(new Set())}
                    disabled={selectedDistricts.size === 0}
                  >
                    נקה הכל
                  </button>
                </div>
                <div className="toolbar-district-list" role="listbox" aria-multiselectable="true">
                  {districtOptions.map((opt) => {
                    const active = selectedDistricts.has(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={`pill ${active ? 'is-active' : ''}`}
                        style={solidPillStyle(opt.value, active)}
                        onClick={() => toggleDistrict(opt.value)}
                      >
                        <span>{opt.label}</span>
                        <span className="pill-count">{opt.count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          ) : null}
        </div>

        <div className="trends-toolbar-spacer" />
        <div className="trends-toolbar-summary" aria-live="polite">
          {filteredAds.length.toLocaleString('he-IL')} מודעות בטווח
        </div>
      </div>

      <div className="trends-grid">
        <TrendKpis data={kpiData} />
        <VolumeTimeSeries series={series} districts={districtsForChart} />
        <DistrictSmallMultiples data={districtTrend} />
        <PriceHistogram data={histogramData} />
        <PriceRoomsScatter ads={filteredAds} />
        <TopCitiesTable data={cities} />
        <RoomsBars data={rooms} />
      </div>
    </div>
  );
}
