'use client';

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
  return (
    <div className="filter-bar">
      <div className="filter-row">
        <div className="filter-field" role="group" aria-label="טריות">
          <span className="filter-label">טריות</span>
          <div className="segmented" role="tablist">
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
        </div>

        <div className="filter-field filter-search">
          <label className="filter-label" htmlFor="filter-search">
            חיפוש
          </label>
          <input
            id="filter-search"
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="כותרת או עיר"
          />
        </div>

        <div className="filter-field">
          <label className="filter-label" htmlFor="filter-sort">
            מיון
          </label>
          <select
            id="filter-sort"
            value={sort}
            onChange={(e) => onSortChange(e.target.value as SortKey)}
          >
            <option value="firstSeenDesc">חדשות יותר קודם</option>
            <option value="priceAsc">מחיר: זול ליקר</option>
            <option value="roomsDesc">חדרים: הרבה לקצת</option>
          </select>
        </div>
      </div>

      <div className="filter-chips" role="group" aria-label="מחוז">
        <span className="filter-label">מחוז</span>
        <button
          type="button"
          className={`pill ${selectedDistricts.size === 0 ? 'is-active' : ''}`}
          onClick={onClearDistricts}
          aria-pressed={selectedDistricts.size === 0}
        >
          הכל
        </button>
        {districtOptions.map((option) => {
          const active = selectedDistricts.has(option.value);
          return (
            <button
              type="button"
              key={option.value}
              className={`pill ${active ? 'is-active' : ''}`}
              aria-pressed={active}
              onClick={() => onToggleDistrict(option.value)}
            >
              <span>{option.label}</span>
              <span className="pill-count">{option.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
