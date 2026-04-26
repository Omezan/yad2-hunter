const ALL_SEARCHES = [
  {
    id: 'center-sharon',
    label: 'מרכז ושרון',
    districtKey: 'center-sharon',
    districtLabel: 'מרכז והשרון',
    url: 'https://www.yad2.co.il/realestate/rent/center-and-sharon?maxPrice=9000&minRooms=4&settlements=1&zoom=9'
  },
  {
    id: 'south',
    label: 'דרום',
    districtKey: 'south',
    districtLabel: 'דרום',
    url: 'https://www.yad2.co.il/realestate/rent/south?maxPrice=9000&minRooms=4&settlements=1&zoom=9'
  },
  {
    id: 'coastal-north',
    label: 'חוף צפוני',
    districtKey: 'coastal-north',
    districtLabel: 'חוף צפוני',
    url: 'https://www.yad2.co.il/realestate/rent/coastal-north?maxPrice=9000&minRooms=4&settlements=1&zoom=9'
  },
  {
    id: 'north-valleys',
    label: 'צפון ועמקים',
    districtKey: 'north-valleys',
    districtLabel: 'צפון והעמקים',
    url: 'https://www.yad2.co.il/realestate/rent/north-and-valleys?maxPrice=9000&minRooms=4&settlements=1&zoom=9'
  },
  {
    id: 'jerusalem',
    label: 'ירושלים',
    districtKey: 'jerusalem',
    districtLabel: 'ירושלים והסביבה',
    url: 'https://www.yad2.co.il/realestate/rent/jerusalem-area?maxPrice=9000&minRooms=4&settlements=1&zoom=9'
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

module.exports = {
  ALL_SEARCHES,
  getEnabledSearches
};
