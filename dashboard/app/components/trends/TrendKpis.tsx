'use client';

import type { Kpis } from '../../lib/trends';

type Props = {
  data: Kpis;
};

function formatShekel(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value).toLocaleString('he-IL')} ₪`;
}

function formatRooms(value: number | null): string {
  if (value === null) return '—';
  return Number.isInteger(value) ? `${value} חדרים` : `${value.toFixed(1)} חדרים`;
}

function DeltaBadge({ pct }: { pct: number | null }) {
  if (pct === null) {
    return (
      <span className="trend-kpi-delta is-neutral" aria-label="אין מספיק נתונים להשוואה">
        —
      </span>
    );
  }
  if (Math.abs(pct) < 0.5) {
    return <span className="trend-kpi-delta is-neutral">≈0%</span>;
  }
  const positive = pct > 0;
  const sign = positive ? '▲' : '▼';
  const rounded = Math.abs(pct) >= 100 ? Math.round(pct) : pct.toFixed(1);
  return (
    <span
      className={`trend-kpi-delta ${positive ? 'is-up' : 'is-down'}`}
      title="שינוי מול החלון הקודם באותו אורך"
    >
      {sign} {rounded}%
    </span>
  );
}

export default function TrendKpis({ data }: Props) {
  return (
    <section className="trend-card trend-card-kpis" aria-label="מדדים מרכזיים">
      <header className="trend-card-header">
        <h3 className="trend-card-title">מדדים מרכזיים</h3>
        <p className="trend-card-subtitle">תצלום זמן של מצב המעקב</p>
      </header>

      <div className="trend-kpi-grid">
        <article className="trend-kpi">
          <div className="trend-kpi-label">סך מודעות במעקב</div>
          <div className="trend-kpi-value">{data.total.toLocaleString('he-IL')}</div>
          <div className="trend-kpi-foot">{data.withPrice.toLocaleString('he-IL')} עם מחיר</div>
        </article>

        <article className="trend-kpi">
          <div className="trend-kpi-label">זוהו ב-7 ימים האחרונים</div>
          <div className="trend-kpi-value">
            {data.last7.count.toLocaleString('he-IL')}
          </div>
          <div className="trend-kpi-foot">
            <DeltaBadge pct={data.last7.deltaPct} /> מול השבוע הקודם
          </div>
        </article>

        <article className="trend-kpi">
          <div className="trend-kpi-label">זוהו ב-30 ימים האחרונים</div>
          <div className="trend-kpi-value">
            {data.last30.count.toLocaleString('he-IL')}
          </div>
          <div className="trend-kpi-foot">
            <DeltaBadge pct={data.last30.deltaPct} /> מול החודש הקודם
          </div>
        </article>

        <article className="trend-kpi">
          <div className="trend-kpi-label">זוהו ב-90 ימים האחרונים</div>
          <div className="trend-kpi-value">
            {data.last90.count.toLocaleString('he-IL')}
          </div>
          <div className="trend-kpi-foot">
            <DeltaBadge pct={data.last90.deltaPct} /> מול 90 הימים שלפני
          </div>
        </article>

        <article className="trend-kpi">
          <div className="trend-kpi-label">מחיר חציוני</div>
          <div className="trend-kpi-value">{formatShekel(data.medianPrice)}</div>
          <div className="trend-kpi-foot">מחושב על מודעות עם מחיר נקלט</div>
        </article>

        <article className="trend-kpi">
          <div className="trend-kpi-label">חציון חדרים</div>
          <div className="trend-kpi-value">{formatRooms(data.medianRooms)}</div>
          <div className="trend-kpi-foot">{data.cities.toLocaleString('he-IL')} ערים נצפו</div>
        </article>
      </div>
    </section>
  );
}
