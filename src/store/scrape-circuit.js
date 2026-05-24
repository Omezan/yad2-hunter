'use strict';

// Global circuit breaker for the Yad2 scraper.
//
// Contract (per the product brief):
//   - One block in a single iteration → just send the existing
//     partial-scrape warning. No freeze yet.
//   - Two consecutive iterations with a block → trip the breaker.
//     Stop ALL scraping for SCRAPE_FREEZE_MS (default 1h), send a
//     freeze notification to Telegram, and auto-resume after the
//     timeout passes.
//   - Any iteration where every attempted search succeeds resets
//     the counter to zero.
//
// State is persisted in `<STATE_DIR>/scrape-circuit.json` and
// survives across Actions runs via the `state` branch. Concurrent
// writers (rare in practice) are reconciled by mergeCircuit in
// scripts/merge-state.js, which prefers the entry with the latest
// lastObservedAt.

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const CIRCUIT_FILE = 'scrape-circuit.json';
const DEFAULT_FREEZE_MS = 60 * 60 * 1000;
const DEFAULT_THRESHOLD = 2;

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
  return {
    consecutiveBlockedIterations: 0,
    frozenUntil: null,
    firstBlockedAt: null,
    lastBlockedAt: null,
    lastObservedAt: null
  };
}

function loadCircuit() {
  const data = readJsonSafe(CIRCUIT_FILE, emptyState());
  if (!data || typeof data !== 'object') return emptyState();
  return {
    consecutiveBlockedIterations:
      Number.isFinite(data.consecutiveBlockedIterations) &&
      data.consecutiveBlockedIterations > 0
        ? Math.floor(data.consecutiveBlockedIterations)
        : 0,
    frozenUntil: typeof data.frozenUntil === 'string' ? data.frozenUntil : null,
    firstBlockedAt:
      typeof data.firstBlockedAt === 'string' ? data.firstBlockedAt : null,
    lastBlockedAt:
      typeof data.lastBlockedAt === 'string' ? data.lastBlockedAt : null,
    lastObservedAt:
      typeof data.lastObservedAt === 'string' ? data.lastObservedAt : null
  };
}

function saveCircuit(state) {
  writeJson(CIRCUIT_FILE, state);
}

function isFrozen(state, nowMs = Date.now()) {
  if (!state || !state.frozenUntil) return false;
  const until = Date.parse(state.frozenUntil);
  return Number.isFinite(until) && until > nowMs;
}

function getFreezeInfo(state) {
  if (!state) return null;
  return {
    frozenUntil: state.frozenUntil || null,
    firstBlockedAt: state.firstBlockedAt || null,
    lastBlockedAt: state.lastBlockedAt || null,
    consecutiveBlockedIterations: state.consecutiveBlockedIterations || 0
  };
}

// Mutate `state` in place to reflect the outcome of one iteration.
// Returns an event descriptor so the caller knows whether the
// breaker just tripped and should send the freeze notification.
//
// Inputs:
//   hadBlock      — any blocked-style scrape error this iteration
//   threshold     — number of consecutive blocked iterations that
//                   trip the breaker (default 2)
//   freezeMs      — how long the freeze lasts (default 1h)
//   nowMs         — current wall-clock; tests inject a fixed value
//
// Outputs:
//   { justFrozen, alreadyFrozen, counter, frozenUntil }
function recordIterationOutcome(
  state,
  { hadBlock, threshold = DEFAULT_THRESHOLD, freezeMs = DEFAULT_FREEZE_MS, nowMs = Date.now() } = {}
) {
  if (!state) return { justFrozen: false, alreadyFrozen: false, counter: 0, frozenUntil: null };

  state.lastObservedAt = new Date(nowMs).toISOString();

  if (hadBlock) {
    state.consecutiveBlockedIterations =
      (state.consecutiveBlockedIterations || 0) + 1;
    state.lastBlockedAt = new Date(nowMs).toISOString();
    if (!state.firstBlockedAt) {
      state.firstBlockedAt = state.lastBlockedAt;
    }

    if (state.consecutiveBlockedIterations >= threshold) {
      state.frozenUntil = new Date(nowMs + Math.max(1, freezeMs)).toISOString();
      return {
        justFrozen: true,
        alreadyFrozen: false,
        counter: state.consecutiveBlockedIterations,
        frozenUntil: state.frozenUntil
      };
    }

    return {
      justFrozen: false,
      alreadyFrozen: false,
      counter: state.consecutiveBlockedIterations,
      frozenUntil: state.frozenUntil
    };
  }

  // No block this iteration → reset the counter and the
  // "first/last blocked" markers. Keep frozenUntil alone (it expires
  // on its own; clearing it here would only ever happen for a
  // successful iteration that ran DURING the freeze, which our
  // worker doesn't do because it short-circuits on isFrozen).
  state.consecutiveBlockedIterations = 0;
  state.firstBlockedAt = null;
  state.lastBlockedAt = null;
  return {
    justFrozen: false,
    alreadyFrozen: false,
    counter: 0,
    frozenUntil: state.frozenUntil
  };
}

module.exports = {
  CIRCUIT_FILE,
  DEFAULT_FREEZE_MS,
  DEFAULT_THRESHOLD,
  emptyState,
  loadCircuit,
  saveCircuit,
  isFrozen,
  getFreezeInfo,
  recordIterationOutcome
};
