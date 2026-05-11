'use client';

import type { Histogram } from '../../lib/trends';

type Props = {
  data: Histogram;
};

const W = 720;
const H = 240;
const PAD = { top: 16, right: 16, bottom: 36, left: 40 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

function formatShekel(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return value.toLocaleString('he-IL');
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / pow;
  let step: number;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 5) step = 5;
  else step = 10;
  return step * pow;
}

export default function PriceHistogram({ data }: Props) {
  const { buckets, median, p25, p75, min, max } = data;
  const maxCount = niceMax(buckets.reduce((acc, b) => Math.max(acc, b.count), 1));
  const slot = buckets.length > 0 ? PLOT_W / buckets.length : 0;
  const barW = Math.max(2, slot * 0.85);

  const tickEvery = (() => {
    if (buckets.length <= 8) return 1;
    if (buckets.length <= 16) return 2;
    return Math.ceil(buckets.length / 8);
  })();

  // Map a price to its X position inside the plot.
  const rangeFrom = buckets.length ? buckets[0].from : 0;
  const rangeTo = buckets.length ? buckets[buckets.length - 1].to : 1;
  const xForPrice = (price: number) => {
    if (rangeTo === rangeFrom) return PAD.left;
    return PAD.left + ((price - rangeFrom) / (rangeTo - rangeFrom)) * PLOT_W;
  };

  return (
    <section className="trend-card trend-card-wide" aria-label="התפלגות מחירים">
      <header className="trend-card-header">
        <h3 className="trend-card-title">התפלגות מחירים</h3>
        <p className="trend-card-subtitle">
          {median !== null
            ? `חציון ${Math.round(median).toLocaleString('he-IL')} ₪`
            : 'אין מספיק נתוני מחיר'}
          {p25 !== null && p75 !== null
            ? ` · רבעון ${Math.round(p25).toLocaleString('he-IL')}–${Math.round(
                p75
              ).toLocaleString('he-IL')} ₪`
            : ''}
          {min !== null && max !== null
            ? ` · ${Math.round(min).toLocaleString('he-IL')}–${Math.round(max).toLocaleString(
                'he-IL'
              )} ₪`
            : ''}
        </p>
      </header>

      {buckets.length === 0 ? (
        <div className="trend-empty">אין מודעות עם מחיר בטווח שנבחר</div>
      ) : (
        <div className="trend-chart">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="none">
            {[0, maxCount / 4, maxCount / 2, (maxCount / 4) * 3, maxCount].map((tick, i) => {
              const y = PAD.top + PLOT_H - (tick / maxCount) * PLOT_H;
              return (
                <g key={i}>
                  <line
                    x1={PAD.left}
                    x2={PAD.left + PLOT_W}
                    y1={y}
                    y2={y}
                    className="trend-grid-line"
                  />
                  <text
                    x={PAD.left - 6}
                    y={y + 4}
                    textAnchor="end"
                    className="trend-axis-label"
                  >
                    {Math.round(tick).toLocaleString('he-IL')}
                  </text>
                </g>
              );
            })}

            {buckets.map((bucket, i) => {
              const x = PAD.left + i * slot + (slot - barW) / 2;
              const h = (bucket.count / maxCount) * PLOT_H;
              const y = PAD.top + PLOT_H - h;
              const showTick = i % tickEvery === 0 || i === buckets.length - 1;
              return (
                <g key={`${bucket.from}-${bucket.to}`}>
                  <rect
                    x={x}
                    y={y}
                    width={barW}
                    height={h}
                    rx={2}
                    className="trend-hist-bar"
                  >
                    <title>{`${formatShekel(bucket.from)}–${formatShekel(
                      bucket.to
                    )} ₪: ${bucket.count.toLocaleString('he-IL')} מודעות`}</title>
                  </rect>
                  {showTick ? (
                    <text
                      x={x + barW / 2}
                      y={PAD.top + PLOT_H + 18}
                      textAnchor="middle"
                      className="trend-axis-label"
                    >
                      {formatShekel(bucket.from)}
                    </text>
                  ) : null}
                </g>
              );
            })}

            {/* Median + IQR overlays */}
            {p25 !== null && p75 !== null ? (
              <rect
                x={xForPrice(p25)}
                y={PAD.top}
                width={Math.max(0, xForPrice(p75) - xForPrice(p25))}
                height={PLOT_H}
                className="trend-hist-iqr"
              />
            ) : null}
            {median !== null ? (
              <line
                x1={xForPrice(median)}
                x2={xForPrice(median)}
                y1={PAD.top}
                y2={PAD.top + PLOT_H}
                className="trend-hist-median"
              >
                <title>{`חציון: ${Math.round(median).toLocaleString('he-IL')} ₪`}</title>
              </line>
            ) : null}

            <line
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={PAD.top + PLOT_H}
              y2={PAD.top + PLOT_H}
              className="trend-axis-line"
            />
          </svg>
        </div>
      )}
    </section>
  );
}
