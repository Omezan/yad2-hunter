'use client';

import type { RoomsRow } from '../../lib/trends';

type Props = {
  data: RoomsRow[];
};

export default function RoomsBars({ data }: Props) {
  if (data.length === 0) {
    return (
      <section className="trend-card" aria-label="התפלגות חדרים">
        <header className="trend-card-header">
          <h3 className="trend-card-title">התפלגות חדרים</h3>
          <p className="trend-card-subtitle">כמה מודעות בכל מספר חדרים</p>
        </header>
        <div className="trend-empty">אין נתונים בטווח שנבחר</div>
      </section>
    );
  }
  const max = Math.max(...data.map((row) => row.count), 1);
  return (
    <section className="trend-card" aria-label="התפלגות חדרים">
      <header className="trend-card-header">
        <h3 className="trend-card-title">התפלגות חדרים</h3>
        <p className="trend-card-subtitle">כמה מודעות בכל מספר חדרים</p>
      </header>
      <ul className="trend-rooms">
        {data.map((row) => {
          const pct = (row.count / max) * 100;
          const isUnknown = row.key === 'unknown';
          return (
            <li key={String(row.key)} className="trend-rooms-row">
              <span className={`trend-rooms-label ${isUnknown ? 'is-muted' : ''}`}>
                {row.label}
              </span>
              <span className="trend-rooms-bar" aria-hidden="true">
                <span
                  className={`trend-rooms-bar-fill ${isUnknown ? 'is-muted' : ''}`}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="trend-rooms-count">
                {row.count.toLocaleString('he-IL')}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
