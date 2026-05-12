const ALL_SEARCHES = [
  {
    id: 'jerusalem',
    label: 'ירושלים',
    districtKey: 'jerusalem',
    districtLabel: 'ירושלים והסביבה',
    url: 'https://www.yad2.co.il/realestate/rent/jerusalem-area?maxPrice=9000&minRooms=4&settlements=1&zoom=9',
    settlementsOnly: true
  },
  {
    id: 'center-sharon',
    label: 'מרכז ושרון',
    districtKey: 'center-sharon',
    districtLabel: 'מרכז והשרון',
    url: 'https://www.yad2.co.il/realestate/rent/center-and-sharon?maxPrice=9000&minRooms=4&settlements=1&zoom=9',
    settlementsOnly: true
  },
  {
    id: 'south',
    label: 'דרום',
    districtKey: 'south',
    districtLabel: 'דרום',
    url: 'https://www.yad2.co.il/realestate/rent/south?maxPrice=9000&minRooms=4&settlements=1&zoom=9',
    settlementsOnly: true
  },
  {
    id: 'coastal-north',
    label: 'חוף צפוני',
    districtKey: 'coastal-north',
    districtLabel: 'חוף צפוני',
    url: 'https://www.yad2.co.il/realestate/rent/coastal-north?maxPrice=9000&minRooms=4&settlements=1&zoom=9',
    settlementsOnly: true
  },
  {
    id: 'north-valleys',
    label: 'צפון ועמקים',
    districtKey: 'north-valleys',
    districtLabel: 'צפון והעמקים',
    url: 'https://www.yad2.co.il/realestate/rent/north-and-valleys?maxPrice=9000&minRooms=4&settlements=1&zoom=9',
    settlementsOnly: true
  },
  // Lev HaPark, Ra'anana watch. Lives outside the moshav-style
  // network — these are urban neighborhood searches with no
  // `settlements=1` constraint and routed to email instead of
  // Telegram (per the dedicated /lev-hapark dashboard page).
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
  }
];

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
  buildFilterLimitsMap
};
