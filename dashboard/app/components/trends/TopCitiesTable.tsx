'use client';

import type { TopCity } from '../../lib/trends';

type Props = {
  data: TopCity[];
};

function formatShekel(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value).toLocaleString('he-IL')} ₪`;
}

export default function TopCitiesTable({ data }: Props) {
  if (data.length === 0) {
    return (
      <section className="trend-card" aria-label="ערים מובילות">
        <header className="trend-card-header">
          <h3 className="trend-card-title">ערים מובילות</h3>
          <p className="trend-card-subtitle">לפי כמות מודעות בטווח שנבחר</p>
        </header>
        <div className="trend-empty">אין נתוני ערים בטווח שנבחר</div>
      </section>
    );
  }

  const max = Math.max(...data.map((row) => row.count), 1);

  return (
    <section className="trend-card" aria-label="ערים מובילות">
      <header className="trend-card-header">
        <h3 className="trend-card-title">ערים מובילות</h3>
        <p className="trend-card-subtitle">
          טופ {data.length} ערים לפי כמות מודעות שזוהו בטווח שנבחר
        </p>
      </header>

      <ol className="trend-cities">
        {data.map((row, idx) => {
          const widthPct = (row.count / max) * 100;
          return (
            <li key={row.city} className="trend-cities-row">
              <span className="trend-cities-rank" aria-hidden="true">
                {idx + 1}
              </span>
              <span className="trend-cities-name">{row.city}</span>
              <span className="trend-cities-bar" aria-hidden="true">
                <span
                  className="trend-cities-bar-fill"
                  style={{ width: `${widthPct}%` }}
                />
              </span>
              <span className="trend-cities-count">
                {row.count.toLocaleString('he-IL')}
              </span>
              <span className="trend-cities-price">{formatShekel(row.medianPrice)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
