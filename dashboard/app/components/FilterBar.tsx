'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent
} from 'react';

export type FreshnessFilter = 'all' | 'new';
export type SortKey = 'firstSeenDesc' | 'priceAsc' | 'roomsDesc';

type DistrictOption = {
  value: string;
  label: string;
  count: number;
};

export type PriceBounds = {
  min: number;
  max: number;
  step: number;
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
  // Price filter
  priceBounds: PriceBounds | null;
  priceMin: number | null;
  priceMax: number | null;
  onPriceMinChange: (value: number | null) => void;
  onPriceMaxChange: (value: number | null) => void;
  onPriceReset: () => void;
};

function formatShekel(value: number): string {
  return new Intl.NumberFormat('he-IL').format(value);
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocumentClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Lock body scroll while behaving as a mobile bottom sheet so the
  // popover content can scroll without the page moving behind.
  useEffect(() => {
    if (!open) return;
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(max-width: 600px)').matches) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return { open, setOpen, ref };
}

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
  hasFreshAds,
  priceBounds,
  priceMin,
  priceMax,
  onPriceMinChange,
  onPriceMaxChange,
  onPriceReset
}: Props) {
  const districtPopover = usePopover();
  const pricePopover = usePopover();

  const districtSummary = (() => {
    if (selectedDistricts.size === 0) return 'הכל';
    if (selectedDistricts.size === 1) {
      const onlyValue = Array.from(selectedDistricts)[0];
      const match = districtOptions.find((o) => o.value === onlyValue);
      return match ? match.label : onlyValue;
    }
    return `${selectedDistricts.size} נבחרו`;
  })();

  const priceFilterActive = useMemo(() => {
    if (!priceBounds) return false;
    if (priceMin !== null && priceMin > priceBounds.min) return true;
    if (priceMax !== null && priceMax < priceBounds.max) return true;
    return false;
  }, [priceBounds, priceMin, priceMax]);

  const priceSummary = (() => {
    if (!priceBounds) return 'הכל';
    const lo = priceMin ?? priceBounds.min;
    const hi = priceMax ?? priceBounds.max;
    if (!priceFilterActive) return 'הכל';
    if (lo <= priceBounds.min) return `עד ${formatShekel(hi)} ₪`;
    if (hi >= priceBounds.max) return `מ-${formatShekel(lo)} ₪`;
    return `${formatShekel(lo)}–${formatShekel(hi)} ₪`;
  })();

  // Track-fill positions for the dual-range slider visual.
  const trackStyle = useMemo(() => {
    if (!priceBounds) return undefined;
    const range = priceBounds.max - priceBounds.min || 1;
    const lo = priceMin ?? priceBounds.min;
    const hi = priceMax ?? priceBounds.max;
    const startPct = ((lo - priceBounds.min) / range) * 100;
    const endPct = ((hi - priceBounds.min) / range) * 100;
    // For RTL the visual "right" side maps to lower numbers, so we use
    // logical offsets: inset-inline-start = startPct, inset-inline-end = 100 - endPct.
    return {
      insetInlineStart: `${startPct}%`,
      insetInlineEnd: `${100 - endPct}%`
    } as React.CSSProperties;
  }, [priceBounds, priceMin, priceMax]);

  const onMinSlider = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (!priceBounds) return;
      const next = Number(e.target.value);
      const cap = priceMax ?? priceBounds.max;
      const clamped = Math.min(next, cap);
      onPriceMinChange(clamped <= priceBounds.min ? null : clamped);
    },
    [priceBounds, priceMax, onPriceMinChange]
  );

  const onMaxSlider = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (!priceBounds) return;
      const next = Number(e.target.value);
      const floor = priceMin ?? priceBounds.min;
      const clamped = Math.max(next, floor);
      onPriceMaxChange(clamped >= priceBounds.max ? null : clamped);
    },
    [priceBounds, priceMin, onPriceMaxChange]
  );

  const onMinInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (!priceBounds) return;
      const raw = e.target.value.replace(/[^\d]/g, '');
      if (raw === '') {
        onPriceMinChange(null);
        return;
      }
      const value = Number(raw);
      const cap = priceMax ?? priceBounds.max;
      const clamped = Math.max(priceBounds.min, Math.min(value, cap));
      onPriceMinChange(clamped <= priceBounds.min ? null : clamped);
    },
    [priceBounds, priceMax, onPriceMinChange]
  );

  const onMaxInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (!priceBounds) return;
      const raw = e.target.value.replace(/[^\d]/g, '');
      if (raw === '') {
        onPriceMaxChange(null);
        return;
      }
      const value = Number(raw);
      const floor = priceMin ?? priceBounds.min;
      const clamped = Math.min(priceBounds.max, Math.max(value, floor));
      onPriceMaxChange(clamped >= priceBounds.max ? null : clamped);
    },
    [priceBounds, priceMin, onPriceMaxChange]
  );

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

      {/* Price filter */}
      <div
        ref={pricePopover.ref}
        className={`toolbar-district ${pricePopover.open ? 'is-open' : ''}`}
      >
        <button
          type="button"
          className={`toolbar-district-button ${priceFilterActive ? 'has-selection' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={pricePopover.open}
          disabled={!priceBounds}
          onClick={() => pricePopover.setOpen((v) => !v)}
        >
          <span>מחיר: {priceSummary}</span>
          <span className="toolbar-district-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {pricePopover.open && priceBounds ? (
          <>
            <div
              className="toolbar-district-backdrop"
              aria-hidden="true"
              onClick={() => pricePopover.setOpen(false)}
            />
            <div
              className="toolbar-district-popover toolbar-price-popover"
              role="dialog"
              aria-modal="true"
            >
              <div className="toolbar-district-header">
                <span className="toolbar-district-title">סינון לפי מחיר</span>
                <button
                  type="button"
                  className="toolbar-district-close"
                  aria-label="סגור"
                  onClick={() => pricePopover.setOpen(false)}
                >
                  ✕
                </button>
              </div>

              <div className="toolbar-price-inputs">
                <label className="toolbar-price-input">
                  <span>מ-</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={priceMin ?? ''}
                    placeholder={String(priceBounds.min)}
                    onChange={onMinInput}
                    aria-label="מחיר מינימלי"
                  />
                  <span className="toolbar-price-suffix">₪</span>
                </label>
                <label className="toolbar-price-input">
                  <span>עד</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={priceMax ?? ''}
                    placeholder={String(priceBounds.max)}
                    onChange={onMaxInput}
                    aria-label="מחיר מקסימלי"
                  />
                  <span className="toolbar-price-suffix">₪</span>
                </label>
              </div>

              <div className="toolbar-price-slider" aria-hidden="false">
                <div className="toolbar-price-track">
                  <div className="toolbar-price-track-fill" style={trackStyle} />
                </div>
                <input
                  type="range"
                  className="toolbar-price-range toolbar-price-range-min"
                  min={priceBounds.min}
                  max={priceBounds.max}
                  step={priceBounds.step}
                  value={priceMin ?? priceBounds.min}
                  onChange={onMinSlider}
                  aria-label="מחיר מינימלי"
                />
                <input
                  type="range"
                  className="toolbar-price-range toolbar-price-range-max"
                  min={priceBounds.min}
                  max={priceBounds.max}
                  step={priceBounds.step}
                  value={priceMax ?? priceBounds.max}
                  onChange={onMaxSlider}
                  aria-label="מחיר מקסימלי"
                />
              </div>

              <div className="toolbar-price-legend">
                <span>{formatShekel(priceBounds.min)} ₪</span>
                <span>{formatShekel(priceBounds.max)} ₪</span>
              </div>

              <div className="toolbar-district-actions">
                <button
                  type="button"
                  className="toolbar-district-link"
                  onClick={() => onPriceReset()}
                  disabled={!priceFilterActive}
                >
                  איפוס
                </button>
              </div>

              <div className="toolbar-district-footer">
                <button
                  type="button"
                  className="toolbar-district-done"
                  onClick={() => pricePopover.setOpen(false)}
                >
                  סיום
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* District filter */}
      <div
        ref={districtPopover.ref}
        className={`toolbar-district ${districtPopover.open ? 'is-open' : ''}`}
      >
        <button
          type="button"
          className={`toolbar-district-button ${
            selectedDistricts.size > 0 ? 'has-selection' : ''
          }`}
          aria-haspopup="listbox"
          aria-expanded={districtPopover.open}
          onClick={() => districtPopover.setOpen((v) => !v)}
        >
          <span>מחוז: {districtSummary}</span>
          {selectedDistricts.size > 0 ? (
            <span className="toolbar-district-count">{selectedDistricts.size}</span>
          ) : null}
          <span className="toolbar-district-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {districtPopover.open ? (
          <>
            <div
              className="toolbar-district-backdrop"
              aria-hidden="true"
              onClick={() => districtPopover.setOpen(false)}
            />
            <div className="toolbar-district-popover" role="dialog" aria-modal="true">
              <div className="toolbar-district-header">
                <span className="toolbar-district-title">בחירת מחוז</span>
                <button
                  type="button"
                  className="toolbar-district-close"
                  aria-label="סגור"
                  onClick={() => districtPopover.setOpen(false)}
                >
                  ✕
                </button>
              </div>
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
              <div className="toolbar-district-list" role="listbox" aria-multiselectable="true">
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
              <div className="toolbar-district-footer">
                <button
                  type="button"
                  className="toolbar-district-done"
                  onClick={() => districtPopover.setOpen(false)}
                >
                  סיום
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
