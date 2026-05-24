'use client';

import { MOSHAV_DISTRICTS } from '../lib/moshav-districts';

// Renders one chip per moshav district that opens the matching Yad2
// search in a new tab. Intended as a manual fallback for the times
// when the scraper is being captcha'd and the user wants to verify
// listings directly on the source.
//
// rel="noreferrer" hides our origin from Yad2 — they do correlate
// referrer with bot traffic and we already get enough scrutiny from
// their anti-bot.
export default function DistrictLinks() {
  return (
    <div className="district-links" aria-label="פתיחת שאילתה ביד 2 ידנית">
      <span className="district-links-label">פתח ביד 2:</span>
      <div className="district-links-row">
        {MOSHAV_DISTRICTS.map((district) => (
          <a
            key={district.id}
            href={district.url}
            target="_blank"
            rel="noreferrer"
            className="district-link-chip"
            title={`פתח ${district.label} ביד 2 בלשונית חדשה`}
          >
            <span className="district-link-icon" aria-hidden="true">
              {district.icon}
            </span>
            <span>{district.label}</span>
            <span className="district-link-arrow" aria-hidden="true">↗</span>
          </a>
        ))}
      </div>
    </div>
  );
}
