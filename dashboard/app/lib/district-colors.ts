// Stable per-district color palette so a district label looks the
// same wherever it appears (card footer chip, filter pill, map pin).
// Colors are tuned to read well on both light and dark surfaces.
//
// Each entry exposes:
//   - solid:      a saturated primary tone (used for the active filter
//                 pill background, map pin gradient end-stop).
//   - solidStrong a slightly darker shade for hover / gradient.
//   - softBg:     a low-alpha translucent fill for chips on cards.
//   - softText:   the readable foreground that goes with softBg.
//   - softBorder: the matching border for softBg-filled chips.

export type DistrictColor = {
  solid: string;
  solidStrong: string;
  softBg: string;
  softText: string;
  softBorder: string;
};

const PALETTE: Record<string, DistrictColor> = {
  // Jerusalem and surroundings — warm gold.
  jerusalem: {
    solid: '#d4a017',
    solidStrong: '#a87a08',
    softBg: 'rgba(212, 160, 23, 0.16)',
    softText: '#e8b938',
    softBorder: 'rgba(212, 160, 23, 0.45)'
  },
  // Center / Sharon — vivid blue.
  'center-sharon': {
    solid: '#3f73ff',
    solidStrong: '#1f49e0',
    softBg: 'rgba(63, 115, 255, 0.16)',
    softText: '#7da4ff',
    softBorder: 'rgba(63, 115, 255, 0.45)'
  },
  // South — desert terracotta.
  south: {
    solid: '#e0552b',
    solidStrong: '#b53d18',
    softBg: 'rgba(224, 85, 43, 0.16)',
    softText: '#f37b54',
    softBorder: 'rgba(224, 85, 43, 0.45)'
  },
  // Coastal north — sea teal.
  'coastal-north': {
    solid: '#0aa6a6',
    solidStrong: '#067f7f',
    softBg: 'rgba(10, 166, 166, 0.16)',
    softText: '#3dc4c4',
    softBorder: 'rgba(10, 166, 166, 0.45)'
  },
  // Galilee / valleys — forest green.
  'north-valleys': {
    solid: '#3aa663',
    solidStrong: '#268048',
    softBg: 'rgba(58, 166, 99, 0.18)',
    softText: '#5fc587',
    softBorder: 'rgba(58, 166, 99, 0.5)'
  }
};

const FALLBACK: DistrictColor = {
  solid: '#6b7280',
  solidStrong: '#4b5563',
  softBg: 'rgba(107, 114, 128, 0.16)',
  softText: '#9ca3af',
  softBorder: 'rgba(107, 114, 128, 0.45)'
};

export function getDistrictColor(searchId: string | null | undefined): DistrictColor {
  if (!searchId) return FALLBACK;
  return PALETTE[searchId] || FALLBACK;
}

// Inline-style helpers — the palette can't move into CSS variables
// because the searchId is dynamic per ad/pill.
export function softChipStyle(searchId: string | null | undefined): React.CSSProperties {
  const c = getDistrictColor(searchId);
  return {
    background: c.softBg,
    color: c.softText,
    borderColor: c.softBorder
  };
}

export function solidPillStyle(
  searchId: string | null | undefined,
  active: boolean
): React.CSSProperties {
  const c = getDistrictColor(searchId);
  if (active) {
    return {
      background: c.solid,
      color: '#fff',
      borderColor: c.solid
    };
  }
  return {
    background: c.softBg,
    color: c.softText,
    borderColor: c.softBorder
  };
}
