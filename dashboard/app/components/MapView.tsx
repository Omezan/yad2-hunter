'use client';

import { useEffect, useMemo, useRef } from 'react';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import cityCoords from '../lib/city-coords.json';
import type { AdRow } from '../lib/types';
import { isAdFresh } from '../lib/freshness';

type CityCoord = { lat: number; lng: number };
const COORDS = cityCoords as Record<string, CityCoord>;

// Israel-ish bounds for the initial view.
const DEFAULT_CENTER: [number, number] = [31.7, 35.0];
const DEFAULT_ZOOM = 7;

function buildCityIcon(count: number, isHot: boolean): L.DivIcon {
  const size = count >= 100 ? 44 : count >= 10 ? 38 : 32;
  const tone = isHot ? 'hot' : 'normal';
  return L.divIcon({
    className: 'map-pin-wrapper',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div class="map-pin map-pin-${tone}" style="width:${size}px;height:${size}px"><span>${count}</span></div>`
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
      .map(([city, items]) => ({
        city,
        coord: COORDS[city],
        ads: items,
        hasFresh: items.some((ad) => isAdFresh(ad.firstSeenAt, effectiveSince))
      }))
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
            icon={buildCityIcon(g.ads.length, g.hasFresh)}
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
