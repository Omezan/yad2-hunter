import type { AdRow } from '../lib/types';
import { formatHebrewDateTime } from '../lib/freshness';

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

export default function AdCard({ ad, isNew }: Props) {
  const price = formatPriceHeadline(ad.price);
  const rooms = formatRooms(ad.rooms);
  const firstSeen = formatHebrewDateTime(ad.firstSeenAt);
  const headline = ad.city || ad.title || 'מודעה';

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
          <span className="card-chip">{ad.districtLabel}</span>
        ) : (
          <span />
        )}
        {firstSeen ? <span className="card-meta">נקלט {firstSeen}</span> : null}
      </div>
    </a>
  );
}
