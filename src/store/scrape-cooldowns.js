'use strict';

// Per-search scrape cooldowns.
//
// Contract (per the product brief):
//   - One block on a specific search X → only X is held out for
//     SCRAPE_COOLDOWN_MS (default 1h). The other 7 searches keep
//     scanning normally every iteration.
//   - Cooldown clears itself by elapsed time. There's no manual
//     "clear" call from the scheduled track — pruning happens on
//     every save.
//   - Manual dashboard scans BYPASS the filter entirely (try every
//     requested search even if it's cooled down) and DO NOT update
//     the cooldown state (so a manual block doesn't extend the
//     scheduled-track cooldown, and a manual success doesn't shorten
//     it). The cooldown is a property of the scheduled track only.
//
// State is persisted in `<STATE_DIR>/scrape-cooldowns.json` next to
// `seen-ads.json` and survives across Actions runs via the `state`
// branch. Concurrent writers are reconciled by `mergeCooldowns` in
// scripts/merge-state.js, which picks the entry with the latest
// observedAt per searchId.

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const COOLDOWNS_FILE = 'scrape-cooldowns.json';
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

function getStatePath(filename) {
  return path.join(env.STATE_DIR, filename);
}

function ensureStateDir() {
  if (!fs.existsSync(env.STATE_DIR)) {
    fs.mkdirSync(env.STATE_DIR, { recursive: true });
  }
}

function readJsonSafe(filename, fallback) {
  const filePath = getStatePath(filename);
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Could not parse ${filename}, starting fresh: ${error.message}`);
    return fallback;
  }
}

function writeJson(filename, data) {
  ensureStateDir();
  const filePath = getStatePath(filename);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function emptyState() {
  return { entries: {} };
}

function loadCooldowns() {
  const data = readJsonSafe(COOLDOWNS_FILE, emptyState());
  if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
    return emptyState();
  }
  // Defensive: make a shallow clone so writes don't mutate the
  // parsed JSON in place (matters for snapshot-style callers).
  return { entries: { ...data.entries } };
}

function saveCooldowns(state) {
  writeJson(COOLDOWNS_FILE, state);
}

// Returns true while the entry's blockedUntil is in the future.
// A missing entry counts as "not cooled down".
function isCooledDown(state, searchId, nowMs = Date.now()) {
  if (!state || !state.entries || !searchId) return false;
  const entry = state.entries[searchId];
  if (!entry || !entry.blockedUntil) return false;
  const until = Date.parse(entry.blockedUntil);
  return Number.isFinite(until) && until > nowMs;
}

// Looks up the raw entry. Useful for the partial-scrape warning so
// it can show the wall-clock retry time.
function getCooldown(state, searchId) {
  if (!state || !state.entries || !searchId) return null;
  return state.entries[searchId] || null;
}

// Map<searchId, entry> of every currently-active cooldown. Filters
// out expired entries so the worker's "skip this search?" check is
// a single Map.has() call.
function buildActiveCooldownMap(state, nowMs = Date.now()) {
  const map = new Map();
  if (!state || !state.entries) return map;
  for (const [searchId, entry] of Object.entries(state.entries)) {
    if (!entry) continue;
    const until = Date.parse(entry.blockedUntil || '');
    if (Number.isFinite(until) && until > nowMs) {
      map.set(searchId, entry);
    }
  }
  return map;
}

// Installs a fresh cooldown for the search. Overwrites any existing
// entry (which is what we want — the freshest block wins).
function setBlocked(state, searchId, durationMs = DEFAULT_COOLDOWN_MS, nowMs = Date.now()) {
  if (!state || !searchId) return state;
  if (!state.entries) state.entries = {};
  const blockedAt = new Date(nowMs).toISOString();
  const blockedUntil = new Date(nowMs + Math.max(1, durationMs)).toISOString();
  state.entries[searchId] = {
    blockedAt,
    blockedUntil,
    observedAt: blockedAt
  };
  return state;
}

// Drop expired entries so the on-disk file doesn't accumulate
// forever. Safe to call before every save.
function pruneExpired(state, nowMs = Date.now()) {
  if (!state || !state.entries) return state;
  for (const [searchId, entry] of Object.entries(state.entries)) {
    const until = Date.parse((entry && entry.blockedUntil) || '');
    if (!Number.isFinite(until) || until <= nowMs) {
      delete state.entries[searchId];
    }
  }
  return state;
}

module.exports = {
  COOLDOWNS_FILE,
  DEFAULT_COOLDOWN_MS,
  emptyState,
  loadCooldowns,
  saveCooldowns,
  isCooledDown,
  getCooldown,
  buildActiveCooldownMap,
  setBlocked,
  pruneExpired
};
