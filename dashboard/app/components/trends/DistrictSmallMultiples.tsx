'use client';

import type { DistrictSeries } from '../../lib/trends';
import { getDistrictColor } from '../../lib/district-colors';

type Props = {
  data: DistrictSeries[];
};

const W = 220;
const H = 64;
const PAD = 4;

function buildPath(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1);
  const stepX = values.length > 1 ? (W - PAD * 2) / (values.length - 1) : 0;
  const points = values.map((v, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - (v / max) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `M${points.join(' L')}`;
}

function buildAreaPath(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1);
  const stepX = values.length > 1 ? (W - PAD * 2) / (values.length - 1) : 0;
  const pts: string[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const x = PAD + i * stepX;
    const y = H - PAD - (values[i] / max) * (H - PAD * 2);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return `M${PAD},${H - PAD} L${pts.join(' L')} L${(W - PAD).toFixed(1)},${H - PAD} Z`;
}

function DeltaBadge({ pct }: { pct: number | null }) {
  if (pct === null) {
    return <span className="trend-spark-delta is-neutral">—</span>;
  }
  if (Math.abs(pct) < 0.5) {
    return <span className="trend-spark-delta is-neutral">≈0%</span>;
  }
  const positive = pct > 0;
  const rounded = Math.abs(pct) >= 100 ? Math.round(pct) : pct.toFixed(0);
  return (
    <span className={`trend-spark-delta ${positive ? 'is-up' : 'is-down'}`}>
      {positive ? '▲' : '▼'} {rounded}%
    </span>
  );
}

export default function DistrictSmallMultiples({ data }: Props) {
  return (
    <section className="trend-card" aria-label="מגמה לפי מחוז">
      <header className="trend-card-header">
        <h3 className="trend-card-title">מגמה לפי מחוז</h3>
        <p className="trend-card-subtitle">
          השוואה בין מחצית ראשונה למחצית שנייה של הטווח הנבחר
        </p>
      </header>

      {data.length === 0 ? (
        <div className="trend-empty">אין נתונים בטווח שנבחר</div>
      ) : (
        <div className="trend-spark-grid">
          {data.map((d) => {
            const color = getDistrictColor(d.searchId);
            const values = d.series.map((p) => p.value);
            return (
              <article key={d.searchId} className="trend-spark">
                <div className="trend-spark-row">
                  <span
                    className="trend-spark-swatch"
                    style={{ background: color.solid }}
                    aria-hidden="true"
                  />
                  <span className="trend-spark-label">{d.label}</span>
                  <span className="trend-spark-total">
                    {d.total.toLocaleString('he-IL')}
                  </span>
                </div>
                <svg
                  className="trend-spark-svg"
                  viewBox={`0 0 ${W} ${H}`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={`גרף קטן ל${d.label}`}
                >
                  <path d={buildAreaPath(values)} fill={color.solid} opacity={0.18} />
                  <path
                    d={buildPath(values)}
                    fill="none"
                    stroke={color.solid}
                    strokeWidth={1.75}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </svg>
                <div className="trend-spark-foot">
                  <span>
                    {d.firstHalf.toLocaleString('he-IL')} →{' '}
                    {d.secondHalf.toLocaleString('he-IL')}
                  </span>
                  <DeltaBadge pct={d.deltaPct} />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
