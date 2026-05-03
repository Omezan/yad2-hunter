'use client';

import { useEffect, useMemo, useRef } from 'react';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import cityCoords from '../lib/city-coords.json';
import type { AdRow } from '../lib/types';
import { isAdFresh } from '../lib/freshness';
import { getDistrictColor } from '../lib/district-colors';

type CityCoord = { lat: number; lng: number };
const COORDS = cityCoords as Record<string, CityCoord>;

// Israel-ish bounds for the initial view.
const DEFAULT_CENTER: [number, number] = [31.7, 35.0];
const DEFAULT_ZOOM = 7;

function buildCityIcon(
  count: number,
  isHot: boolean,
  districtId: string | null
): L.DivIcon {
  const size = count >= 100 ? 44 : count >= 10 ? 38 : 32;
  const baseClass = isHot ? 'map-pin map-pin-hot' : 'map-pin';
  // The "hot" treatment (a city with at least one fresh ad) keeps its
  // amber/red glow so new ads remain visually loud on the map. Otherwise
  // the pin takes its district's brand color so the user can see which
  // district each settlement belongs to at a glance.
  const districtColor = districtId ? getDistrictColor(districtId) : null;
  const inlineStyle =
    !isHot && districtColor
      ? `width:${size}px;height:${size}px;background:linear-gradient(135deg, ${districtColor.solid} 0%, ${districtColor.solidStrong} 100%);box-shadow:0 2px 6px rgba(0,0,0,0.35), 0 0 0 3px ${districtColor.softBg}`
      : `width:${size}px;height:${size}px`;
  return L.divIcon({
    className: 'map-pin-wrapper',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div class="${baseClass}" style="${inlineStyle}"><span>${count}</span></div>`
  });
}

function formatPrice(price: number | null): string {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return 'מחיר לא מצוין';
  }
  return `${price.toLocaleString('he-IL')} ₪`;
}

function formatRooms(rooms: number | null): string {
  if (typeof rooms !== 'number' || !Number.isFinite(rooms) || rooms <= 0) return '';
  return `${rooms} חדרים`;
}

type MapViewProps = {
  ads: AdRow[];
  effectiveSince: string | null;
};

type CityGroup = {
  city: string;
  coord: CityCoord;
  ads: AdRow[];
  hasFresh: boolean;
  // Most-common district for the city (used to color the pin). Cities
  // virtually always sit in a single district but a few border towns
  // could appear under two — we pick the majority.
  districtId: string | null;
};

export default function MapView({ ads, effectiveSince }: MapViewProps) {
  const groups = useMemo<CityGroup[]>(() => {
    const byCity = new Map<string, AdRow[]>();
    for (const ad of ads) {
      const city = (ad.city || '').trim();
      if (!city) continue;
      if (!COORDS[city]) continue;
      const list = byCity.get(city);
      if (list) list.push(ad);
      else byCity.set(city, [ad]);
    }
    return Array.from(byCity.entries())
      .map(([city, items]) => {
        const counts = new Map<string, number>();
        for (const ad of items) {
          const id = ad.searchId || '';
          if (!id) continue;
          counts.set(id, (counts.get(id) || 0) + 1);
        }
        let districtId: string | null = null;
        let best = 0;
        for (const [id, n] of counts) {
          if (n > best) {
            best = n;
            districtId = id;
          }
        }
        return {
          city,
          coord: COORDS[city],
          ads: items,
          hasFresh: items.some((ad) => isAdFresh(ad.firstSeenAt, effectiveSince)),
          districtId
        };
      })
      .sort((a, b) => b.ads.length - a.ads.length);
  }, [ads, effectiveSince]);

  // Count ads we couldn't place (unknown city / no coords).
  const unmapped = useMemo(
    () =>
      ads.filter((ad) => {
        const city = (ad.city || '').trim();
        return !city || !COORDS[city];
      }),
    [ads]
  );

  return (
    <div className="map-shell">
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        scrollWheelZoom={true}
        style={{ height: '100%', width: '100%' }}
        attributionControl={false}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          maxZoom={18}
        />
        {groups.map((g) => (
          <Marker
            key={g.city}
            position={[g.coord.lat, g.coord.lng]}
            icon={buildCityIcon(g.ads.length, g.hasFresh, g.districtId)}
          >
            <Popup>
              <div className="map-popup">
                <div className="map-popup-title">
                  {g.city}
                  <span className="map-popup-count">{g.ads.length} מודעות</span>
                </div>
                <ul className="map-popup-list">
                  {g.ads.map((ad) => {
                    const fresh = isAdFresh(ad.firstSeenAt, effectiveSince);
                    return (
                      <li key={ad.externalId} className={fresh ? 'is-fresh' : ''}>
                        <a href={ad.link} target="_blank" rel="noopener noreferrer">
                          <span className="map-popup-price">{formatPrice(ad.price)}</span>
                          {formatRooms(ad.rooms) ? (
                            <span className="map-popup-rooms"> · {formatRooms(ad.rooms)}</span>
                          ) : null}
                          {fresh ? <span className="map-popup-new">חדש</span> : null}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      {unmapped.length > 0 ? (
        <div className="map-unmapped-note">
          {unmapped.length} מודעות לא מופיעות במפה (יישוב לא מזוהה)
        </div>
      ) : null}
    </div>
  );
}
