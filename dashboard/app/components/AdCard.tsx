import type { AdRow } from '../lib/types';
import { formatHebrewDateTime } from '../lib/freshness';
import { softChipStyle } from '../lib/district-colors';

type Props = {
  ad: AdRow;
  isNew: boolean;
};

function formatRooms(rooms: number | null): string | null {
  if (typeof rooms !== 'number') return null;
  const display = Number.isInteger(rooms) ? rooms.toString() : rooms.toFixed(1);
  return `${display} חדרים`;
}

function formatPriceHeadline(price: number | null): { value: string; muted: boolean } {
  if (typeof price !== 'number') return { value: 'מחיר לא מצוין', muted: true };
  return { value: `${price.toLocaleString('he-IL')} ₪`, muted: false };
}

function isPlaceholderText(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  return trimmed === 'מודעה' || trimmed === 'מודעה ללא כותרת';
}

export default function AdCard({ ad, isNew }: Props) {
  const price = formatPriceHeadline(ad.price);
  const rooms = formatRooms(ad.rooms);
  const firstSeen = formatHebrewDateTime(ad.firstSeenAt);
  // Headline preference: real city -> non-placeholder title -> district.
  // The list-card scrape captures `city` for almost every record; the
  // fallback chain just covers the rare case where city is missing
  // because Yad2's card layout was unusual on that listing.
  const headline =
    (ad.city && ad.city.trim()) ||
    (!isPlaceholderText(ad.title) ? ad.title : null) ||
    ad.districtLabel ||
    '—';

  return (
    <a
      href={ad.link}
      target="_blank"
      rel="noopener noreferrer"
      className={`card ${isNew ? 'is-new' : ''}`}
      aria-label={`${headline}, ${price.value}${rooms ? `, ${rooms}` : ''}`}
    >
      {isNew ? (
        <span className="card-ribbon" aria-label="חדש">
          חדש
        </span>
      ) : null}

      <div className="card-headline">{headline}</div>

      <div className="card-price-row">
        <span className={`card-price ${price.muted ? 'is-muted' : ''}`}>{price.value}</span>
        {rooms ? <span className="card-rooms">{rooms}</span> : null}
      </div>

      <div className="card-footer">
        {ad.districtLabel ? (
          <span className="card-chip" style={softChipStyle(ad.searchId)}>
            {ad.districtLabel}
          </span>
        ) : (
          <span />
        )}
        {firstSeen ? <span className="card-meta">נקלט {firstSeen}</span> : null}
      </div>
    </a>
  );
}
