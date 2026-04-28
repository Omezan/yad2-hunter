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

function formatPrice(price: number | null): string {
  if (typeof price !== 'number') return 'מחיר לא מצוין';
  return `${price.toLocaleString('he-IL')} ₪`;
}

export default function AdCard({ ad, isNew }: Props) {
  const facts = [formatRooms(ad.rooms), formatPrice(ad.price)].filter(Boolean) as string[];
  const firstSeen = formatHebrewDateTime(ad.firstSeenAt);

  return (
    <a
      href={ad.link}
      target="_blank"
      rel="noopener noreferrer"
      className={`card ${isNew ? 'is-new' : ''}`}
    >
      {isNew ? <span className="new-tag">חדש</span> : null}
      <div className="title">{ad.title || 'מודעה'}</div>
      {ad.city ? <div className="facts"><span>{ad.city}</span></div> : null}
      {facts.length ? (
        <div className="facts">
          {facts.map((fact, i) => (
            <span key={i}>{fact}</span>
          ))}
        </div>
      ) : null}
      <div className="footer">
        {ad.districtLabel ? (
          <span className="district-tag">{ad.districtLabel}</span>
        ) : (
          <span />
        )}
        {firstSeen ? <span>נקלט {firstSeen}</span> : null}
      </div>
    </a>
  );
}
