'use client';

import { useEffect, useRef, useState } from 'react';

export type FreshnessFilter = 'all' | 'new';
export type SortKey = 'firstSeenDesc' | 'priceAsc' | 'roomsDesc';

type DistrictOption = {
  value: string;
  label: string;
  count: number;
};

type Props = {
  freshness: FreshnessFilter;
  onFreshnessChange: (value: FreshnessFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
  sort: SortKey;
  onSortChange: (value: SortKey) => void;
  districtOptions: DistrictOption[];
  selectedDistricts: Set<string>;
  onToggleDistrict: (value: string) => void;
  onClearDistricts: () => void;
  hasFreshAds: boolean;
};

export default function FilterBar({
  freshness,
  onFreshnessChange,
  search,
  onSearchChange,
  sort,
  onSortChange,
  districtOptions,
  selectedDistricts,
  onToggleDistrict,
  onClearDistricts,
  hasFreshAds
}: Props) {
  const [districtOpen, setDistrictOpen] = useState(false);
  const districtRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!districtOpen) return;
    const onDocumentClick = (e: MouseEvent) => {
      if (!districtRef.current) return;
      if (districtRef.current.contains(e.target as Node)) return;
      setDistrictOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDistrictOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocumentClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [districtOpen]);

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
    <div className="filter-toolbar" role="toolbar" aria-label="סינון">
      <div className="segmented" role="tablist" aria-label="טריות">
        <button
          type="button"
          role="tab"
          aria-selected={freshness === 'all'}
          className={`segmented-option ${freshness === 'all' ? 'is-active' : ''}`}
          onClick={() => onFreshnessChange('all')}
        >
          הכל
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={freshness === 'new'}
          disabled={!hasFreshAds}
          className={`segmented-option ${freshness === 'new' ? 'is-active' : ''}`}
          onClick={() => onFreshnessChange('new')}
        >
          חדשות {hasFreshAds ? '' : '(אין)'}
        </button>
      </div>

      <div className="toolbar-search">
        <input
          id="filter-search"
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="חיפוש: כותרת או עיר"
          aria-label="חיפוש"
        />
      </div>

      <div className="toolbar-sort">
        <select
          id="filter-sort"
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          aria-label="מיון"
        >
          <option value="firstSeenDesc">חדשות יותר קודם</option>
          <option value="priceAsc">מחיר: זול ליקר</option>
          <option value="roomsDesc">חדרים: הרבה לקצת</option>
        </select>
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
          <span className="toolbar-district-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {districtOpen ? (
          <div className="toolbar-district-popover" role="listbox">
            <div className="toolbar-district-actions">
              <button
                type="button"
                className="toolbar-district-link"
                onClick={() => {
                  onClearDistricts();
                }}
                disabled={selectedDistricts.size === 0}
              >
                נקה הכל
              </button>
            </div>
            <div className="toolbar-district-list">
              {districtOptions.map((option) => {
                const active = selectedDistricts.has(option.value);
                return (
                  <button
                    type="button"
                    key={option.value}
                    role="option"
                    aria-selected={active}
                    className={`pill ${active ? 'is-active' : ''}`}
                    onClick={() => onToggleDistrict(option.value)}
                  >
                    <span>{option.label}</span>
                    <span className="pill-count">{option.count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
