#!/usr/bin/env node
/**
 * One-shot migration: scrub Yad2 error-widget text from existing
 * `seen-ads.json`. Run against a checked-out `state` branch so the
 * next scan loop's heal step can refill `city` / `title` from a real
 * detail-page enrichment.
 *
 * Usage: node scripts/scrub-poison-state.js path/to/seen-ads.json
 */
const fs = require('fs');

function isPoison(value) {
  return typeof value === 'string' && /אופס\.{2,3}\s*תקלה/.test(value);
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/scrub-poison-state.js <seen-ads.json>');
    process.exit(2);
  }
  if (!fs.existsSync(target)) {
    console.error(`file not found: ${target}`);
    process.exit(2);
  }
  const raw = fs.readFileSync(target, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data.ads !== 'object') {
    console.error('seen-ads.json is missing the `ads` object');
    process.exit(2);
  }
  let scrubbed = 0;
  for (const [id, record] of Object.entries(data.ads)) {
    let touched = false;
    if (isPoison(record.city)) {
      record.city = null;
      touched = true;
    }
    if (isPoison(record.title)) {
      record.title = 'מודעה';
      touched = true;
    }
    if (touched) {
      scrubbed += 1;
      data.ads[id] = record;
    }
  }
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`scrubbed ${scrubbed} record(s) of Yad2 error-widget text`);
}

main();
