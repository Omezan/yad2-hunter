const STORAGE_KEY = 'yad2-hunter-last-visit-at';

export function readLastVisitAt(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeLastVisitAt(value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* ignore quota errors */
  }
}

export function clearLastVisitAt(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function pickEffectiveSince(
  searchParamSince: string | null,
  lastVisitAt: string | null
): string | null {
  if (searchParamSince && !Number.isNaN(Date.parse(searchParamSince))) {
    return searchParamSince;
  }
  if (lastVisitAt && !Number.isNaN(Date.parse(lastVisitAt))) {
    return lastVisitAt;
  }
  return null;
}

export function isAdFresh(firstSeenAt: string, since: string | null): boolean {
  if (!since) return false;
  const adTime = Date.parse(firstSeenAt);
  const sinceTime = Date.parse(since);
  if (Number.isNaN(adTime) || Number.isNaN(sinceTime)) return false;
  return adTime > sinceTime;
}

export function formatHebrewDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}
