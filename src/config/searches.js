const ALL_SEARCHES = [
  {
    id: 'jerusalem',
    label: 'ירושלים',
    districtKey: 'jerusalem',
    districtLabel: 'ירושלים והסביבה',
    url: 'https://www.yad2.co.il/realestate/rent/jerusalem-area?maxPrice=9500&minRooms=4&settlements=1&zoom=9',
    settlementsOnly: true
  },
  {
    id: 'center-sharon',
    label: 'מרכז ושרון',
    districtKey: 'center-sharon',
    districtLabel: 'מרכז והשרון',
    url: 'https://www.yad2.co.il/realestate/rent/center-and-sharon?maxPrice=9500&minRooms=4&settlements=1&zoom=9',
    settlementsOnly: true
  },
  {
    id: 'south',
    label: 'דרום',
    districtKey: 'south',
    districtLabel: 'דרום',
    url: 'https://www.yad2.co.il/realestate/rent/south?maxPrice=9500&minRooms=4&settlements=1&zoom=9',
    settlementsOnly: true
  },
  {
    id: 'coastal-north',
    label: 'חוף צפוני',
    districtKey: 'coastal-north',
    districtLabel: 'חוף צפוני',
    url: 'https://www.yad2.co.il/realestate/rent/coastal-north?maxPrice=9500&minRooms=4&settlements=1&zoom=9',
    settlementsOnly: true
  },
  {
    id: 'north-valleys',
    label: 'צפון ועמקים',
    districtKey: 'north-valleys',
    districtLabel: 'צפון והעמקים',
    url: 'https://www.yad2.co.il/realestate/rent/north-and-valleys?maxPrice=9500&minRooms=4&settlements=1&zoom=9',
    settlementsOnly: true
  },
  // Lev HaPark, Ra'anana watch. Lives outside the moshav-style
  // network — these are urban neighborhood searches with no
  // `settlements=1` constraint. New-ad notifications are routed to
  // email instead of Telegram (per the dedicated /lev-hapark
  // dashboard page); the daily health-check reconciles them just
  // like every other watch.
  {
    id: 'lev-hapark-rent',
    label: 'לב הפארק — שכירות',
    districtKey: 'lev-hapark',
    districtLabel: 'לב הפארק, רעננה',
    url: 'https://www.yad2.co.il/realestate/rent/center-and-sharon?minRooms=5&area=42&city=8700&neighborhood=807',
    settlementsOnly: false,
    notifyVia: 'email'
  },
  {
    id: 'lev-hapark-sale',
    label: 'לב הפארק — מכירה',
    districtKey: 'lev-hapark',
    districtLabel: 'לב הפארק, רעננה',
    url: 'https://www.yad2.co.il/realestate/forsale/center-and-sharon?minRooms=5&area=42&city=8700&neighborhood=807',
    settlementsOnly: false,
    notifyVia: 'email'
  },
  // Urban rentals across a fixed list of cities in מרכז ושרון
  // (multiCity Yad2 ids: 6900, 9700, 8700, 8300, 2620), 4+ rooms,
  // ≤ 9000₪, apartments / penthouses / duplexes. Routes to Telegram
  // (no notifyVia override) and is reconciled by the daily
  // health-check together with the moshav and lev-hapark watches.
  {
    id: 'rent-in-cities',
    label: 'שכירות בערים',
    districtKey: 'rent-in-cities',
    districtLabel: 'שכירות בערים — מרכז ושרון',
    url: 'https://www.yad2.co.il/realestate/rent/center-and-sharon?maxPrice=9000&minRooms=4&property=3%2C5%2C39&multiCity=6900%2C9700%2C8700%2C8300%2C2620',
    settlementsOnly: false
  }
];

// Rewrite a single search's URL so its `maxPrice` query param equals the
// requested budget. Only touches searches that ALREADY filter by price
// (the moshav rentals + rent-in-cities) — the Lev HaPark watches filter
// by neighborhood and carry no maxPrice, so they're left untouched. A
// non-positive / invalid budget is a no-op so callers can pass through
// user input without pre-checking.
function withMaxPrice(search, maxPrice) {
  const price = Number.parseInt(maxPrice, 10);
  if (!Number.isFinite(price) || price <= 0) return search;
  if (!search || typeof search.url !== 'string') return search;
  let url;
  try {
    url = new URL(search.url);
  } catch {
    return search;
  }
  if (!url.searchParams.has('maxPrice')) return search;
  url.searchParams.set('maxPrice', String(price));
  return { ...search, url: url.toString() };
}

// Apply a per-run budget override to a list of searches. Returns the
// same list unchanged when no valid override is given.
function applyMaxPriceOverride(searches, maxPrice) {
  const price = Number.parseInt(maxPrice, 10);
  if (!Number.isFinite(price) || price <= 0) return searches;
  return (searches || []).map((search) => withMaxPrice(search, price));
}

function getEnabledSearches(enabledIds = '') {
  const requestedIds = enabledIds
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!requestedIds.length) {
    return ALL_SEARCHES;
  }

  const enabledSet = new Set(requestedIds);
  return ALL_SEARCHES.filter((search) => enabledSet.has(search.id));
}

// Searches reconciled by the daily health-check. Every watch is in
// scope now — the moshav, Lev HaPark, and rent-in-cities watches are
// all probed once a day and the reconciler is the sole owner of
// deletions. (The legacy `excludeFromHealthCheck` flag was removed
// when the in-scan self-prune path was retired.)
function getHealthCheckSearches() {
  return ALL_SEARCHES.slice();
}

// Pulls the price/room ceiling-and-floor encoded in the search URL,
// so other components (e.g. the health-check relevance filter) can
// reuse the exact same constraints we sent to Yad2 — no risk of two
// places drifting out of sync.
function getFilterLimits(search) {
  if (!search || typeof search.url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(search.url);
  } catch {
    return null;
  }
  const maxPriceRaw = parsed.searchParams.get('maxPrice');
  const minRoomsRaw = parsed.searchParams.get('minRooms');
  const maxPrice = maxPriceRaw != null ? Number.parseFloat(maxPriceRaw) : null;
  const minRooms = minRoomsRaw != null ? Number.parseFloat(minRoomsRaw) : null;
  return {
    maxPrice: Number.isFinite(maxPrice) ? maxPrice : null,
    minRooms: Number.isFinite(minRooms) ? minRooms : null
  };
}

function buildFilterLimitsMap(searches = ALL_SEARCHES) {
  const map = new Map();
  for (const search of searches) {
    if (!search || !search.id) continue;
    map.set(search.id, getFilterLimits(search));
  }
  return map;
}

module.exports = {
  ALL_SEARCHES,
  getEnabledSearches,
  getFilterLimits,
  buildFilterLimitsMap,
  getHealthCheckSearches,
  applyMaxPriceOverride,
  withMaxPrice
};
