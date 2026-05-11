import type { AdRow } from './types';

// =====================================================================
// Range / bucket types
// =====================================================================

export type RangeKey = '7d' | '30d' | '90d' | '365d' | 'all';
export type Granularity = 'auto' | 'day' | 'week' | 'month';
export type Bucket = 'day' | 'week' | 'month';

export type Bucketed = {
  /** ISO date string for the start of the bucket (UTC midnight or week start). */
  key: string;
  /** Pre-formatted label suitable for the X-axis tick (he-IL). */
  label: string;
  total: number;
  byGroup: Record<string, number>;
  /** True if this bucket is the bootstrap spike (a single day that holds
   * a disproportionate share of all firstSeenAt entries, which happens
   * because every ad on hand the first time the scraper ran shares the
   * same firstSeenAt).
   */
  isBootstrap: boolean;
};

export type Kpis = {
  total: number;
  withPrice: number;
  cities: number;
  /** Last-N-days counts and their delta (%) vs the prior window. */
  last7: { count: number; deltaPct: number | null };
  last30: { count: number; deltaPct: number | null };
  last90: { count: number; deltaPct: number | null };
  medianPrice: number | null;
  medianRooms: number | null;
};

export type Histogram = {
  buckets: { from: number; to: number; count: number }[];
  median: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
};

export type TopCity = {
  city: string;
  count: number;
  medianPrice: number | null;
};

export type RoomsRow = {
  /** number for known rooms, 'unknown' otherwise. */
  key: number | 'unknown';
  label: string;
  count: number;
};

export type DistrictSeries = {
  searchId: string;
  label: string;
  series: { key: string; value: number }[];
  /** Total over the whole range. */
  total: number;
  /** Counts in the first vs second half of the range (for the delta arrow). */
  firstHalf: number;
  secondHalf: number;
  deltaPct: number | null;
};

// =====================================================================
// Range filtering
// =====================================================================

export function rangeToDays(range: RangeKey): number | null {
  switch (range) {
    case '7d':
      return 7;
    case '30d':
      return 30;
    case '90d':
      return 90;
    case '365d':
      return 365;
    case 'all':
    default:
      return null;
  }
}

export function pickRange(ads: AdRow[], range: RangeKey, now: number = Date.now()): AdRow[] {
  const days = rangeToDays(range);
  if (days === null) return ads;
  const since = now - days * 24 * 60 * 60 * 1000;
  const filtered: AdRow[] = [];
  for (const ad of ads) {
    const t = Date.parse(ad.firstSeenAt);
    if (Number.isNaN(t)) continue;
    if (t >= since) filtered.push(ad);
  }
  return filtered;
}

// =====================================================================
// Bucket math
// =====================================================================

export function chooseBucket(range: RangeKey, granularity: Granularity): Bucket {
  if (granularity !== 'auto') return granularity;
  switch (range) {
    case '7d':
      return 'day';
    case '30d':
      return 'day';
    case '90d':
      return 'week';
    case '365d':
      return 'week';
    case 'all':
    default:
      return 'month';
  }
}

/** Floor a UTC date to its bucket boundary and return the ISO key. */
function floorBucket(ts: number, bucket: Bucket): { key: string; ms: number } {
  const d = new Date(ts);
  if (bucket === 'day') {
    const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return { key: new Date(utc).toISOString(), ms: utc };
  }
  if (bucket === 'week') {
    // Anchor weeks to Sunday (matches Israeli calendars).
    const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const dow = new Date(utc).getUTCDay();
    const start = utc - dow * 24 * 60 * 60 * 1000;
    return { key: new Date(start).toISOString(), ms: start };
  }
  // month
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return { key: new Date(utc).toISOString(), ms: utc };
}

function nextBucket(ms: number, bucket: Bucket): number {
  const d = new Date(ms);
  if (bucket === 'day') return ms + 24 * 60 * 60 * 1000;
  if (bucket === 'week') return ms + 7 * 24 * 60 * 60 * 1000;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function formatBucketLabel(key: string, bucket: Bucket): string {
  const d = new Date(key);
  if (Number.isNaN(d.getTime())) return '—';
  if (bucket === 'day') {
    return d.toLocaleDateString('he-IL', {
      timeZone: 'Asia/Jerusalem',
      day: '2-digit',
      month: '2-digit'
    });
  }
  if (bucket === 'week') {
    const end = new Date(d.getTime() + 6 * 24 * 60 * 60 * 1000);
    const fromStr = d.toLocaleDateString('he-IL', {
      timeZone: 'Asia/Jerusalem',
      day: '2-digit',
      month: '2-digit'
    });
    const toStr = end.toLocaleDateString('he-IL', {
      timeZone: 'Asia/Jerusalem',
      day: '2-digit',
      month: '2-digit'
    });
    return `${fromStr}–${toStr}`;
  }
  // month
  return d.toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    month: 'short',
    year: '2-digit'
  });
}

/**
 * Bucket ads by firstSeenAt. Zero-fills missing buckets across the
 * range so charts don't break. If `groupBy` is provided (typically
 * `searchId`), the per-group counts are recorded under `byGroup`.
 */
export function bucketByTime(
  ads: AdRow[],
  bucket: Bucket,
  groupBy: (ad: AdRow) => string = () => '_',
  options: { range?: RangeKey; now?: number } = {}
): Bucketed[] {
  const now = options.now ?? Date.now();
  if (!ads.length) return [];

  // Determine the [start, end] anchor of the dense series.
  const tsList: number[] = [];
  for (const ad of ads) {
    const t = Date.parse(ad.firstSeenAt);
    if (!Number.isNaN(t)) tsList.push(t);
  }
  if (!tsList.length) return [];

  const rangeDays = options.range ? rangeToDays(options.range) : null;
  const sinceFromRange =
    rangeDays !== null ? now - rangeDays * 24 * 60 * 60 * 1000 : Math.min(...tsList);
  const start = floorBucket(sinceFromRange, bucket).ms;
  const end = floorBucket(now, bucket).ms;

  const map = new Map<string, Bucketed>();

  // Pre-seed every bucket so the series is dense.
  let cursor = start;
  while (cursor <= end) {
    const key = new Date(cursor).toISOString();
    map.set(key, {
      key,
      label: formatBucketLabel(key, bucket),
      total: 0,
      byGroup: {},
      isBootstrap: false
    });
    cursor = nextBucket(cursor, bucket);
  }

  for (const ad of ads) {
    const t = Date.parse(ad.firstSeenAt);
    if (Number.isNaN(t)) continue;
    const { key, ms } = floorBucket(t, bucket);
    if (ms < start || ms > end) continue;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        key,
        label: formatBucketLabel(key, bucket),
        total: 0,
        byGroup: {},
        isBootstrap: false
      };
      map.set(key, entry);
    }
    entry.total += 1;
    const g = groupBy(ad);
    entry.byGroup[g] = (entry.byGroup[g] || 0) + 1;
  }

  const series = Array.from(map.values()).sort(
    (a, b) => Date.parse(a.key) - Date.parse(b.key)
  );

  // Bootstrap-spike detection: only meaningful when range = 'all' and we
  // have more than one bucket. If a single bucket holds >= 60% of all
  // observations AND the day is the earliest bucket, mark it as bootstrap.
  if (bucket === 'day' && series.length > 1) {
    const grandTotal = series.reduce((acc, s) => acc + s.total, 0);
    if (grandTotal > 0) {
      const earliest = series.find((s) => s.total > 0);
      if (earliest && earliest.total / grandTotal >= 0.6) {
        earliest.isBootstrap = true;
      }
    }
  }

  return series;
}

// =====================================================================
// KPIs
// =====================================================================

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function countAdsSince(ads: AdRow[], since: number, until: number = Infinity): number {
  let n = 0;
  for (const ad of ads) {
    const t = Date.parse(ad.firstSeenAt);
    if (Number.isNaN(t)) continue;
    if (t >= since && t < until) n += 1;
  }
  return n;
}

function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

export function kpis(ads: AdRow[], now: number = Date.now()): Kpis {
  const DAY = 24 * 60 * 60 * 1000;
  const last7Start = now - 7 * DAY;
  const prev7Start = now - 14 * DAY;
  const last30Start = now - 30 * DAY;
  const prev30Start = now - 60 * DAY;
  const last90Start = now - 90 * DAY;
  const prev90Start = now - 180 * DAY;

  const last7 = countAdsSince(ads, last7Start);
  const prev7 = countAdsSince(ads, prev7Start, last7Start);
  const last30 = countAdsSince(ads, last30Start);
  const prev30 = countAdsSince(ads, prev30Start, last30Start);
  const last90 = countAdsSince(ads, last90Start);
  const prev90 = countAdsSince(ads, prev90Start, last90Start);

  const prices: number[] = [];
  const rooms: number[] = [];
  const cities = new Set<string>();
  for (const ad of ads) {
    if (typeof ad.price === 'number' && Number.isFinite(ad.price) && ad.price > 0) {
      prices.push(ad.price);
    }
    if (typeof ad.rooms === 'number' && Number.isFinite(ad.rooms) && ad.rooms > 0) {
      rooms.push(ad.rooms);
    }
    if (ad.city && ad.city.trim()) cities.add(ad.city.trim());
  }

  return {
    total: ads.length,
    withPrice: prices.length,
    cities: cities.size,
    last7: { count: last7, deltaPct: deltaPct(last7, prev7) },
    last30: { count: last30, deltaPct: deltaPct(last30, prev30) },
    last90: { count: last90, deltaPct: deltaPct(last90, prev90) },
    medianPrice: median(prices),
    medianRooms: median(rooms)
  };
}

// =====================================================================
// Price histogram
// =====================================================================

function chooseHistogramBucketWidth(prices: number[]): number {
  if (prices.length < 2) return 500;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = Math.max(1, max - min);
  // Aim for ~12–18 buckets across the range.
  const ideal = span / 14;
  const candidates = [100, 250, 500, 1000, 2000, 5000, 10000];
  for (const c of candidates) {
    if (c >= ideal) return c;
  }
  return candidates[candidates.length - 1];
}

export function pricesHistogram(ads: AdRow[], bucketWidth?: number): Histogram {
  const prices: number[] = [];
  for (const ad of ads) {
    if (typeof ad.price === 'number' && Number.isFinite(ad.price) && ad.price > 0) {
      prices.push(ad.price);
    }
  }
  if (!prices.length) {
    return { buckets: [], median: null, p25: null, p75: null, min: null, max: null };
  }

  const width = bucketWidth ?? chooseHistogramBucketWidth(prices);
  const min = Math.floor(Math.min(...prices) / width) * width;
  const max = Math.ceil(Math.max(...prices) / width) * width;

  const buckets: { from: number; to: number; count: number }[] = [];
  for (let from = min; from < max; from += width) {
    buckets.push({ from, to: from + width, count: 0 });
  }
  if (buckets.length === 0) {
    buckets.push({ from: min, to: min + width, count: 0 });
  }

  for (const price of prices) {
    const idx = Math.min(buckets.length - 1, Math.floor((price - min) / width));
    if (idx >= 0) buckets[idx].count += 1;
  }

  return {
    buckets,
    median: median(prices),
    p25: quantile(prices, 0.25),
    p75: quantile(prices, 0.75),
    min: Math.min(...prices),
    max: Math.max(...prices)
  };
}

// =====================================================================
// Top cities
// =====================================================================

export function topCities(ads: AdRow[], k: number = 10): TopCity[] {
  const byCity = new Map<string, { count: number; prices: number[] }>();
  for (const ad of ads) {
    const city = (ad.city || '').trim();
    if (!city) continue;
    const entry = byCity.get(city) || { count: 0, prices: [] };
    entry.count += 1;
    if (typeof ad.price === 'number' && Number.isFinite(ad.price) && ad.price > 0) {
      entry.prices.push(ad.price);
    }
    byCity.set(city, entry);
  }
  return Array.from(byCity.entries())
    .map(([city, info]) => ({
      city,
      count: info.count,
      medianPrice: median(info.prices)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, k);
}

// =====================================================================
// Rooms distribution
// =====================================================================

export function roomsDistribution(ads: AdRow[]): RoomsRow[] {
  const counts = new Map<number | 'unknown', number>();
  for (const ad of ads) {
    if (typeof ad.rooms === 'number' && Number.isFinite(ad.rooms) && ad.rooms > 0) {
      // Snap to half-integer.
      const snapped = Math.round(ad.rooms * 2) / 2;
      counts.set(snapped, (counts.get(snapped) || 0) + 1);
    } else {
      counts.set('unknown', (counts.get('unknown') || 0) + 1);
    }
  }
  const known: RoomsRow[] = [];
  for (const [key, count] of counts.entries()) {
    if (key === 'unknown') continue;
    const num = key as number;
    const label = Number.isInteger(num) ? `${num}` : num.toFixed(1);
    known.push({ key: num, label: `${label} חד׳`, count });
  }
  known.sort((a, b) => (a.key as number) - (b.key as number));
  const unknownCount = counts.get('unknown') || 0;
  if (unknownCount > 0) {
    known.push({ key: 'unknown', label: 'לא ידוע', count: unknownCount });
  }
  return known;
}

// =====================================================================
// Per-district trend (small multiples)
// =====================================================================

export function perDistrictTrend(
  ads: AdRow[],
  bucket: Bucket,
  options: { range?: RangeKey; now?: number } = {}
): DistrictSeries[] {
  const series = bucketByTime(ads, bucket, (ad) => ad.searchId || 'other', options);
  if (!series.length) return [];

  // Build searchId → label map (most recent districtLabel wins, falls
  // back to searchLabel, then to the raw id).
  const labelById = new Map<string, string>();
  for (const ad of ads) {
    const id = ad.searchId || 'other';
    const label = ad.districtLabel || ad.searchLabel || id;
    labelById.set(id, label);
  }

  const ids = new Set<string>();
  for (const point of series) {
    for (const id of Object.keys(point.byGroup)) ids.add(id);
  }

  const half = Math.floor(series.length / 2);

  const result: DistrictSeries[] = [];
  for (const id of ids) {
    const pts = series.map((p) => ({ key: p.key, value: p.byGroup[id] || 0 }));
    let firstHalf = 0;
    let secondHalf = 0;
    for (let i = 0; i < pts.length; i += 1) {
      if (i < half) firstHalf += pts[i].value;
      else secondHalf += pts[i].value;
    }
    const total = firstHalf + secondHalf;
    result.push({
      searchId: id,
      label: labelById.get(id) || id,
      series: pts,
      total,
      firstHalf,
      secondHalf,
      deltaPct: deltaPct(secondHalf, firstHalf)
    });
  }

  return result.sort((a, b) => b.total - a.total);
}

// =====================================================================
// Misc helpers re-exported for components
// =====================================================================

export const __testing = {
  median,
  quantile,
  floorBucket,
  nextBucket,
  formatBucketLabel,
  countAdsSince,
  deltaPct,
  chooseHistogramBucketWidth
};
