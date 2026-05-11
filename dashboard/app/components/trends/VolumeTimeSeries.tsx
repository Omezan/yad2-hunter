'use client';

import { useMemo, useState } from 'react';
import type { Bucketed } from '../../lib/trends';
import { getDistrictColor } from '../../lib/district-colors';

type DistrictMeta = {
  id: string;
  label: string;
};

type Props = {
  series: Bucketed[];
  districts: DistrictMeta[];
  /** Visual title shown in the card header. */
  title?: string;
};

const WIDTH = 720;
const HEIGHT = 280;
const PADDING = { top: 16, right: 16, bottom: 36, left: 40 };
const PLOT_W = WIDTH - PADDING.left - PADDING.right;
const PLOT_H = HEIGHT - PADDING.top - PADDING.bottom;

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

export default function VolumeTimeSeries({
  series,
  districts,
  title = 'נפח מודעות לאורך זמן'
}: Props) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const visibleDistricts = useMemo(
    () => districts.filter((d) => !hidden.has(d.id)),
    [districts, hidden]
  );

  const maxTotal = useMemo(() => {
    if (!series.length) return 1;
    return series.reduce((acc, point) => {
      let sum = 0;
      for (const d of visibleDistricts) sum += point.byGroup[d.id] || 0;
      return Math.max(acc, sum);
    }, 1);
  }, [series, visibleDistricts]);

  const yMax = niceMax(maxTotal);

  // Layout: gap-respecting bars.
  const slot = series.length > 0 ? PLOT_W / series.length : 0;
  const barW = Math.max(2, Math.min(28, slot * 0.7));

  // Decide tick density on the X axis so labels don't collide.
  const xTickEvery = (() => {
    if (series.length <= 8) return 1;
    if (series.length <= 16) return 2;
    if (series.length <= 32) return 4;
    if (series.length <= 64) return 8;
    return Math.ceil(series.length / 8);
  })();

  // Y ticks (4 lines + zero).
  const yTicks = [0, yMax / 4, yMax / 2, (yMax / 4) * 3, yMax];

  return (
    <section className="trend-card trend-card-wide" aria-label={title}>
      <header className="trend-card-header">
        <h3 className="trend-card-title">{title}</h3>
        <p className="trend-card-subtitle">
          כל מודעה ממוקמת ביום בו זוהתה לראשונה ע״י הסורק
        </p>
      </header>

      {series.length === 0 ? (
        <div className="trend-empty">אין נתונים בטווח שנבחר</div>
      ) : (
        <>
          <div className="trend-chart">
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              role="img"
              aria-label={title}
              preserveAspectRatio="none"
            >
              {/* Y grid + labels */}
              {yTicks.map((tickValue, i) => {
                const y = PADDING.top + PLOT_H - (tickValue / yMax) * PLOT_H;
                return (
                  <g key={`y-${i}`}>
                    <line
                      x1={PADDING.left}
                      x2={PADDING.left + PLOT_W}
                      y1={y}
                      y2={y}
                      className="trend-grid-line"
                    />
                    <text
                      x={PADDING.left - 6}
                      y={y + 4}
                      textAnchor="end"
                      className="trend-axis-label"
                    >
                      {Math.round(tickValue).toLocaleString('he-IL')}
                    </text>
                  </g>
                );
              })}

              {/* Bars (stacked by visible districts) */}
              {series.map((point, i) => {
                const cx = PADDING.left + i * slot + slot / 2;
                let yCursor = PADDING.top + PLOT_H;
                const stack: JSX.Element[] = [];
                let total = 0;
                for (const d of visibleDistricts) {
                  const count = point.byGroup[d.id] || 0;
                  if (count === 0) continue;
                  const h = (count / yMax) * PLOT_H;
                  yCursor -= h;
                  const color = getDistrictColor(d.id).solid;
                  stack.push(
                    <rect
                      key={`${point.key}-${d.id}`}
                      x={cx - barW / 2}
                      y={yCursor}
                      width={barW}
                      height={h}
                      rx={2}
                      fill={color}
                      opacity={point.isBootstrap ? 0.35 : 0.9}
                    />
                  );
                  total += count;
                }
                const showTick = i % xTickEvery === 0 || i === series.length - 1;
                return (
                  <g key={point.key}>
                    {stack}
                    {showTick ? (
                      <text
                        x={cx}
                        y={PADDING.top + PLOT_H + 18}
                        textAnchor="middle"
                        className="trend-axis-label"
                      >
                        {point.label}
                      </text>
                    ) : null}
                    {total > 0 ? (
                      <title>
                        {point.label}
                        {point.isBootstrap ? ' (כולל מודעות שהיו במעקב לפני שהתחלנו לאסוף)' : ''}
                        {`: ${total.toLocaleString('he-IL')} מודעות`}
                      </title>
                    ) : null}
                  </g>
                );
              })}

              {/* Baseline */}
              <line
                x1={PADDING.left}
                x2={PADDING.left + PLOT_W}
                y1={PADDING.top + PLOT_H}
                y2={PADDING.top + PLOT_H}
                className="trend-axis-line"
              />
            </svg>
          </div>

          <div className="trend-legend" role="group" aria-label="מקרא לפי מחוז">
            {districts.map((d) => {
              const isOff = hidden.has(d.id);
              const color = getDistrictColor(d.id).solid;
              return (
                <button
                  key={d.id}
                  type="button"
                  className={`trend-legend-item ${isOff ? 'is-off' : ''}`}
                  onClick={() => {
                    setHidden((prev) => {
                      const next = new Set(prev);
                      if (next.has(d.id)) next.delete(d.id);
                      else next.add(d.id);
                      return next;
                    });
                  }}
                  aria-pressed={!isOff}
                  title={isOff ? `הצג ${d.label}` : `הסתר ${d.label}`}
                >
                  <span
                    className="trend-legend-swatch"
                    style={{ background: color }}
                    aria-hidden="true"
                  />
                  <span>{d.label}</span>
                </button>
              );
            })}
          </div>

          {series.some((s) => s.isBootstrap) ? (
            <p className="trend-note">
              היום הראשון מוצג בעמום — הוא כולל מודעות שכבר היו בעת תחילת המעקב.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
