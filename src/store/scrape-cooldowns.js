'use strict';

// Per-search cooldowns: once Yad2 captcha-blocks a specific search,
// we stop hitting that search for COOLDOWN_DURATION_MS (default 1h)
// on the theory that Yad2's per-query rate limit will relax if we
// stop banging on the door. Cleared the moment we observe a
// successful scrape on the same search.
//
// State lives in `<STATE_DIR>/scrape-cooldowns.json` and survives
// across Actions runs via the `state` branch. The merge layer
// (scripts/merge-state.js) preserves entries across concurrent
// writers by picking the entry with the latest `observedAt`.

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

function loadCooldowns() {
  const data = readJsonSafe(COOLDOWNS_FILE, { entries: {} });
  if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
    return { entries: {} };
  }
  return data;
}

function saveCooldowns(state) {
  writeJson(COOLDOWNS_FILE, state);
}

// Returns the active cooldown record for a search, or null if there
// is no entry or the existing entry has already expired (we let the
// next save() prune expired records implicitly).
function getActiveCooldown(state, searchId, nowMs = Date.now()) {
  if (!state || !state.entries || !searchId) return null;
  const entry = state.entries[searchId];
  if (!entry) return null;
  const until = Date.parse(entry.blockedUntil || '');
  if (!Number.isFinite(until) || until <= nowMs) return null;
  return entry;
}

// Build a quick lookup of `{ searchId: true }` for every entry that
// is still in cooldown right now. Used by the worker to decide which
// searches to skip this iteration.
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

function clearCooldown(state, searchId, nowMs = Date.now()) {
  if (!state || !searchId || !state.entries) return state;
  if (state.entries[searchId]) {
    delete state.entries[searchId];
  }
  // Touch a synthetic "observedAt" marker so the merge layer knows
  // this writer DID look at this search and chose not to keep a
  // cooldown for it. Otherwise a concurrent writer's stale "blocked"
  // entry could win the merge purely because it has any observedAt
  // at all.
  if (!state.cleared) state.cleared = {};
  state.cleared[searchId] = new Date(nowMs).toISOString();
  return state;
}

// Drop expired entries from the on-disk view so the file doesn't
// accumulate forever. Safe to call before save.
function pruneExpired(state, nowMs = Date.now()) {
  if (!state) return state;
  if (state.entries && typeof state.entries === 'object') {
    for (const [searchId, entry] of Object.entries(state.entries)) {
      const until = Date.parse((entry && entry.blockedUntil) || '');
      if (!Number.isFinite(until) || until <= nowMs) {
        delete state.entries[searchId];
      }
    }
  }
  // Cleared markers older than the cooldown duration are no longer
  // useful (any concurrent writer's "blocked" entry from that long
  // ago would itself be expired).
  if (state.cleared && typeof state.cleared === 'object') {
    const cutoff = nowMs - DEFAULT_COOLDOWN_MS * 2;
    for (const [searchId, observedAt] of Object.entries(state.cleared)) {
      const ts = Date.parse(observedAt || '');
      if (!Number.isFinite(ts) || ts <= cutoff) {
        delete state.cleared[searchId];
      }
    }
  }
  return state;
}

// Render the entry as a flat object the notification layer can read.
function describeCooldown(entry) {
  if (!entry) return null;
  return {
    blockedAt: entry.blockedAt || null,
    blockedUntil: entry.blockedUntil || null,
    observedAt: entry.observedAt || entry.blockedAt || null
  };
}

module.exports = {
  COOLDOWNS_FILE,
  DEFAULT_COOLDOWN_MS,
  loadCooldowns,
  saveCooldowns,
  getActiveCooldown,
  buildActiveCooldownMap,
  setBlocked,
  clearCooldown,
  pruneExpired,
  describeCooldown
};
