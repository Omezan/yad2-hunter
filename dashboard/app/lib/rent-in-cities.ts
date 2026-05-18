// Single source of truth for the "שכירות בערים" watch identifiers.
// These ads live in the same global /api/state payload as the moshav
// and Lev HaPark listings, but are surfaced exclusively on the
// /rent-in-cities dashboard page; the home dashboard filters them
// out by searchId (see dashboard/app/page.tsx).
export const RENT_IN_CITIES_SEARCH_IDS = new Set(['rent-in-cities']);

export function isRentInCitiesSearchId(searchId: string | null | undefined): boolean {
  return typeof searchId === 'string' && RENT_IN_CITIES_SEARCH_IDS.has(searchId);
}
