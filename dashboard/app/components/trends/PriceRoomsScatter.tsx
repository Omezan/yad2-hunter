'use client';

import { useMemo } from 'react';
import type { AdRow } from '../../lib/types';
import { getDistrictColor } from '../../lib/district-colors';

type Props = {
  ads: AdRow[];
};

const W = 720;
const H = 280;
const PAD = { top: 16, right: 16, bottom: 36, left: 56 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

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

export default function PriceRoomsScatter({ ads }: Props) {
  const points = useMemo(
    () =>
      ads.filter(
        (ad) =>
          typeof ad.price === 'number' &&
          Number.isFinite(ad.price) &&
          ad.price > 0 &&
          typeof ad.rooms === 'number' &&
          Number.isFinite(ad.rooms) &&
          ad.rooms > 0
      ),
    [ads]
  );

  if (points.length === 0) {
    return (
      <section className="trend-card" aria-label="מחיר מול חדרים">
        <header className="trend-card-header">
          <h3 className="trend-card-title">מחיר מול חדרים</h3>
          <p className="trend-card-subtitle">
            צבע לפי מחוז — חושף חריגים (מודעות זולות במיוחד או יקרות במיוחד)
          </p>
        </header>
        <div className="trend-empty">אין מספיק מודעות עם מחיר וחדרים בטווח שנבחר</div>
      </section>
    );
  }

  const maxPrice = niceMax(Math.max(...points.map((p) => p.price as number)));
  const maxRooms = Math.max(1, Math.ceil(Math.max(...points.map((p) => p.rooms as number))));
  const minRooms = 1;

  const xForRooms = (rooms: number) =>
    PAD.left + ((rooms - minRooms) / Math.max(1, maxRooms - minRooms)) * PLOT_W;
  const yForPrice = (price: number) =>
    PAD.top + PLOT_H - (price / maxPrice) * PLOT_H;

  const yTicks = [0, maxPrice / 4, maxPrice / 2, (maxPrice / 4) * 3, maxPrice];
  const xTicks: number[] = [];
  for (let r = minRooms; r <= maxRooms; r += 1) xTicks.push(r);

  return (
    <section className="trend-card trend-card-wide" aria-label="מחיר מול חדרים">
      <header className="trend-card-header">
        <h3 className="trend-card-title">מחיר מול חדרים</h3>
        <p className="trend-card-subtitle">
          כל נקודה היא מודעה — צבע לפי מחוז. גרירת העכבר מעל נקודה מציגה פרטים.
        </p>
      </header>

      <div className="trend-chart">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="none">
          {yTicks.map((tick, i) => {
            const y = yForPrice(tick);
            return (
              <g key={`y-${i}`}>
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

          {xTicks.map((r) => (
            <g key={`x-${r}`}>
              <line
                x1={xForRooms(r)}
                x2={xForRooms(r)}
                y1={PAD.top}
                y2={PAD.top + PLOT_H}
                className="trend-grid-line is-vertical"
              />
              <text
                x={xForRooms(r)}
                y={PAD.top + PLOT_H + 18}
                textAnchor="middle"
                className="trend-axis-label"
              >
                {r}
              </text>
            </g>
          ))}

          {points.map((p) => {
            const cx = xForRooms(p.rooms as number);
            const cy = yForPrice(p.price as number);
            const color = getDistrictColor(p.searchId).solid;
            return (
              <circle
                key={p.externalId}
                cx={cx}
                cy={cy}
                r={4}
                fill={color}
                fillOpacity={0.7}
                stroke={color}
                strokeOpacity={0.95}
              >
                <title>
                  {`${p.city || p.districtLabel || 'מודעה'} · ${(p.price as number)
                    .toLocaleString('he-IL')} ₪ · ${p.rooms} חדרים`}
                </title>
              </circle>
            );
          })}

          <line
            x1={PAD.left}
            x2={PAD.left + PLOT_W}
            y1={PAD.top + PLOT_H}
            y2={PAD.top + PLOT_H}
            className="trend-axis-line"
          />

          <text
            x={PAD.left + PLOT_W / 2}
            y={H - 4}
            textAnchor="middle"
            className="trend-axis-title"
          >
            חדרים
          </text>
          <text
            x={12}
            y={PAD.top + PLOT_H / 2}
            transform={`rotate(-90 12 ${PAD.top + PLOT_H / 2})`}
            textAnchor="middle"
            className="trend-axis-title"
          >
            מחיר ₪
          </text>
        </svg>
      </div>
    </section>
  );
}
