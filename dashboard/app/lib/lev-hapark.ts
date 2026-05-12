// Single source of truth for the Lev HaPark watch identifiers.
// These ads live in the same global state file as the moshav listings,
// but are surfaced exclusively on the /lev-hapark dashboard page; the
// home dashboard filters them out by searchId.
export const LEV_HAPARK_SEARCH_IDS = new Set(['lev-hapark-rent', 'lev-hapark-sale']);

export function isLevHaParkSearchId(searchId: string | null | undefined): boolean {
  return typeof searchId === 'string' && LEV_HAPARK_SEARCH_IDS.has(searchId);
}
