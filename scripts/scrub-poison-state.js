#!/usr/bin/env node
/**
 * One-shot migration script for `seen-ads.json`. Two responsibilities:
 *
 *  1. Scrub Yad2 error-widget text ("אופס... תקלה!") from city/title.
 *  2. Heal records whose `title` is actually a price string or a rooms
 *     count (legacy list-card scraping bug). When found, we parse the
 *     value out into the structured `price` / `rooms` fields and reset
 *     the title to a neutral placeholder so the dashboard does not
 *     show a price string as the headline.
 *
 * Usage: node scripts/scrub-poison-state.js path/to/seen-ads.json
 */
const fs = require('fs');

function isErrorWidget(value) {
  return typeof value === 'string' && /אופס\.{2,3}\s*תקלה/.test(value);
}

function parsePriceFromTitle(title) {
  if (typeof title !== 'string') return null;
  const match = title.match(/(?:[\d.,]+)\s*₪|₪\s*([\d.,]+)/);
  if (!match) return null;
  const numericText = (match[0].match(/[\d.,]+/) || [''])[0].replace(/[^\d]/g, '');
  if (!numericText) return null;
  const value = Number.parseInt(numericText, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseRoomsFromTitle(title) {
  if (typeof title !== 'string') return null;
  const match = title.match(/(\d+(?:\.\d+)?)\s*(?:חד׳|חדר(?:ים)?)/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function looksPriceLikeTitle(title) {
  if (typeof title !== 'string') return false;
  // "₪ 5,300", "5300 ₪", "ירד ב-500 ₪", or pure currency strings.
  return /₪/.test(title) || /\d{2,}\s*ש"?ח/.test(title);
}

function looksRoomsOnlyTitle(title) {
  if (typeof title !== 'string') return false;
  return /^\d+(?:\.\d+)?\s*(?:חד׳|חדר(?:ים)?)$/.test(title.trim());
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
  let scrubbedWidget = 0;
  let healedPriceFromTitle = 0;
  let healedRoomsFromTitle = 0;
  let resetTitle = 0;
  for (const [id, record] of Object.entries(data.ads)) {
    let touched = false;

    if (isErrorWidget(record.city)) {
      record.city = null;
      scrubbedWidget += 1;
      touched = true;
    }
    if (isErrorWidget(record.title)) {
      record.title = 'מודעה';
      touched = true;
    }

    // Heal a price hidden inside the title.
    if ((record.price === null || record.price === undefined) && looksPriceLikeTitle(record.title)) {
      const parsed = parsePriceFromTitle(record.title);
      if (parsed !== null) {
        record.price = parsed;
        healedPriceFromTitle += 1;
        touched = true;
      }
    }

    // Heal rooms hidden inside the title.
    if ((record.rooms === null || record.rooms === undefined) && looksRoomsOnlyTitle(record.title)) {
      const parsed = parseRoomsFromTitle(record.title);
      if (parsed !== null) {
        record.rooms = parsed;
        healedRoomsFromTitle += 1;
        touched = true;
      }
    }

    // Once we've extracted any structured info, neutralise the title
    // so the dashboard headline doesn't render the price string.
    if (looksPriceLikeTitle(record.title) || looksRoomsOnlyTitle(record.title)) {
      record.title = 'מודעה';
      resetTitle += 1;
      touched = true;
    }

    if (touched) {
      data.ads[id] = record;
    }
  }
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    `scrubbed widget: ${scrubbedWidget}, healed price-from-title: ${healedPriceFromTitle}, healed rooms-from-title: ${healedRoomsFromTitle}, neutralised titles: ${resetTitle}`
  );
}

main();
