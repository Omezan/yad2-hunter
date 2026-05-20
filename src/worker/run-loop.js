// Long-running wrapper around runOnce. We re-introduced the loop on top
// of an hourly GitHub Actions tick because GitHub's scheduler is
// observably unreliable for short cron intervals on free-tier accounts
// — `*/30 * * * *` often slips to 60–240 min between firings under
// platform load. Hosting the loop inside one runner makes the scan
// cadence independent of the scheduler at the cost of a single
// runner-hour budget per hour.
//
// The loop is strictly additive: every iteration calls runOnce(), which
// notifies on new ads and writes them into seen-ads.json. It NEVER
// deletes records — deletions are owned exclusively by the daily
// health-check workflow.
const { spawnSync } = require('child_process');
const path = require('path');
const { runOnce } = require('./run-once');
const { listRecentRuns } = require('../store/file-store');

// Default to one scan every 30 minutes, matching the user-facing
// promise on the dashboard. The previous architecture used 5 min,
// which burned through anti-bot tolerance unnecessarily.
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
// Stop scheduling new iterations once we're within this much of the
// hourly deadline. Leaves enough room for the final persist-state.sh
// push plus the GitHub Action's own teardown.
const SAFETY_BUFFER_MS = 90 * 1000;
// Default per-job wall-clock budget, sized so the workflow finishes
// before the next hourly tick can collide on the same concurrency
// group (see scan.yml: group: yad2-scan, cancel-in-progress: false).
const DEFAULT_BUDGET_MS = 55 * 60 * 1000;

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pure helper: decide whether another iteration fits in the budget.
// Exposed for unit tests so the budget math stays deterministic.
function shouldRunAnotherIteration({ now, deadline, intervalMs, safetyBufferMs }) {
  const remaining = deadline - now;
  return remaining >= intervalMs + safetyBufferMs;
}

// Pure helper: compute how long the loop should sleep between
// iterations, given how long the previous one took. We always sleep
// at least 5 s so a runaway runOnce can't busy-loop the runner.
function computeSleepMs({ intervalMs, lastIterationDurationMs }) {
  const remaining = intervalMs - lastIterationDurationMs;
  return Math.max(remaining, 5000);
}

function persistState() {
  const script = path.resolve(__dirname, '..', '..', 'scripts', 'persist-state.sh');
  const result = spawnSync('bash', [script], {
    stdio: 'inherit',
    env: process.env
  });
  if (result.status !== 0) {
    console.warn(
      `[run-loop] persist-state.sh exited with status ${result.status}; continuing loop`
    );
  }
}

async function main() {
  const intervalMs = parsePositiveInt(
    process.env.LOOP_INTERVAL_MS,
    DEFAULT_INTERVAL_MS
  );
  const totalBudgetMs = parsePositiveInt(
    process.env.LOOP_BUDGET_MS,
    DEFAULT_BUDGET_MS
  );
  const persistEachIteration = parseBool(
    process.env.LOOP_PERSIST_EACH_ITERATION,
    true
  );

  const deadline = Date.now() + totalBudgetMs;
  let iteration = 0;
  let exitCode = 0;

  console.log(
    `[run-loop] starting | budget=${Math.round(totalBudgetMs / 1000)}s interval=${Math.round(
      intervalMs / 1000
    )}s persistPerIteration=${persistEachIteration}`
  );

  while (true) {
    iteration += 1;
    const iterStart = Date.now();
    console.log(
      `\n[run-loop] iteration #${iteration} starting at ${new Date(
        iterStart
      ).toISOString()} (deadline in ${Math.round((deadline - iterStart) / 1000)}s)`
    );

    try {
      const result = await runOnce({ trigger: 'github-actions-loop' });
      console.log(
        `[run-loop] iteration #${iteration} completed: relevantNewAds=${result.relevantNewAds} totalAds=${result.totalAds}`
      );
    } catch (error) {
      exitCode = 1;
      console.error(
        `[run-loop] iteration #${iteration} failed: ${
          error && error.message ? error.message : error
        }`
      );
    }

    if (persistEachIteration) {
      persistState();
    }

    const iterDuration = Date.now() - iterStart;
    if (
      !shouldRunAnotherIteration({
        now: Date.now(),
        deadline,
        intervalMs,
        safetyBufferMs: SAFETY_BUFFER_MS
      })
    ) {
      console.log(
        `[run-loop] not enough budget for another iteration (remaining=${Math.round(
          (deadline - Date.now()) / 1000
        )}s) — exiting after ${iteration} iteration(s)`
      );
      break;
    }

    const sleepMs = computeSleepMs({
      intervalMs,
      lastIterationDurationMs: iterDuration
    });
    console.log(
      `[run-loop] sleeping ${Math.round(sleepMs / 1000)}s before iteration #${
        iteration + 1
      }`
    );
    await sleep(sleepMs);
  }

  const recentRuns = listRecentRuns(5);
  console.log(
    `\n[run-loop] finished — completed ${iteration} iteration(s). Recent runs:\n${JSON.stringify(
      recentRuns,
      null,
      2
    )}`
  );

  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[run-loop] fatal error:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  __testing: {
    DEFAULT_BUDGET_MS,
    DEFAULT_INTERVAL_MS,
    SAFETY_BUFFER_MS,
    computeSleepMs,
    parseBool,
    parsePositiveInt,
    shouldRunAnotherIteration
  }
};
