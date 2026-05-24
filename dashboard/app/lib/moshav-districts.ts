// The five moshav-network watches surfaced on the main dashboard.
//
// These mirror the `ALL_SEARCHES` entries in `src/config/searches.js` for
// the five `settlementsOnly: true` rentals. Lev HaPark and rent-in-cities
// live on their own pages and intentionally don't appear here.
//
// We duplicate the metadata here (instead of fetching it through
// `/api/state`) for two reasons:
//   1. The links are static — they never change between requests, and
//      paying an extra round-trip just to render five chips would be
//      silly.
//   2. The dashboard runs as a client component; pulling a CommonJS
//      config from `src/` would force us to either expose a new API
//      route or bundle the worker code into the browser. Neither is
//      worth it for five strings.
//
// If you ever change a search URL in `src/config/searches.js`, update
// the matching entry below.
export type MoshavDistrict = {
  /** Matches `searchId` in src/config/searches.js. */
  id: string;
  /** Hebrew label for the chip. */
  label: string;
  /** Optional emoji shown next to the label. */
  icon: string;
  /** Yad2 search URL opened in a new tab. */
  url: string;
};

export const MOSHAV_DISTRICTS: readonly MoshavDistrict[] = [
  {
    id: 'jerusalem',
    label: 'ירושלים והסביבה',
    icon: '🏔️',
    url: 'https://www.yad2.co.il/realestate/rent/jerusalem-area?maxPrice=9000&minRooms=4&settlements=1&zoom=9'
  },
  {
    id: 'center-sharon',
    label: 'מרכז והשרון',
    icon: '🏙️',
    url: 'https://www.yad2.co.il/realestate/rent/center-and-sharon?maxPrice=9000&minRooms=4&settlements=1&zoom=9'
  },
  {
    id: 'south',
    label: 'דרום',
    icon: '🌵',
    url: 'https://www.yad2.co.il/realestate/rent/south?maxPrice=9000&minRooms=4&settlements=1&zoom=9'
  },
  {
    id: 'coastal-north',
    label: 'חוף צפוני',
    icon: '🌊',
    url: 'https://www.yad2.co.il/realestate/rent/coastal-north?maxPrice=9000&minRooms=4&settlements=1&zoom=9'
  },
  {
    id: 'north-valleys',
    label: 'צפון והעמקים',
    icon: '🌲',
    url: 'https://www.yad2.co.il/realestate/rent/north-and-valleys?maxPrice=9000&minRooms=4&settlements=1&zoom=9'
  }
] as const;
