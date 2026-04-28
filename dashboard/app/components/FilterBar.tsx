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
      <label>
        טריות
        <select
          value={freshness}
          onChange={(e) => onFreshnessChange(e.target.value as FreshnessFilter)}
        >
          <option value="all">הכל</option>
          <option value="new" disabled={!hasFreshAds}>
            חדשות בלבד {hasFreshAds ? '' : '(אין)'}
          </option>
        </select>
      </label>

      <label>
        חיפוש
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="כותרת או עיר"
        />
      </label>

      <label>
        מיון
        <select value={sort} onChange={(e) => onSortChange(e.target.value as SortKey)}>
          <option value="firstSeenDesc">חדשות יותר קודם</option>
          <option value="priceAsc">מחיר: זול לקר</option>
          <option value="roomsDesc">חדרים: הרבה לקצת</option>
        </select>
      </label>

      <div className="district-chips">
        <span className="label">מחוז</span>
        <button
          type="button"
          className={`chip ${selectedDistricts.size === 0 ? 'active' : ''}`}
          onClick={onClearDistricts}
        >
          הכל
        </button>
        {districtOptions.map((option) => (
          <button
            type="button"
            key={option.value}
            className={`chip ${selectedDistricts.has(option.value) ? 'active' : ''}`}
            onClick={() => onToggleDistrict(option.value)}
          >
            {option.label} ({option.count})
          </button>
        ))}
      </div>
    </div>
  );
}
