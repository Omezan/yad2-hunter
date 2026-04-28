const { spawnSync } = require('child_process');
const path = require('path');
const { runOnce } = require('./run-once');
const { listRecentRuns } = require('../store/file-store');

const ITERATION_INTERVAL_MS = 5 * 60 * 1000;
const SAFETY_BUFFER_MS = 90 * 1000;

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function persistState() {
  const script = path.resolve(__dirname, '..', '..', 'scripts', 'persist-state.sh');
  const result = spawnSync('bash', [script], {
    stdio: 'inherit',
    env: process.env
  });
  if (result.status !== 0) {
    console.warn(
      `persist-state.sh exited with status ${result.status}; continuing loop`
    );
  }
}

async function main() {
  const totalBudgetMs = parsePositiveInt(
    process.env.LOOP_BUDGET_MS,
    55 * 60 * 1000
  );
  const intervalMs = parsePositiveInt(
    process.env.LOOP_INTERVAL_MS,
    ITERATION_INTERVAL_MS
  );
  const persistEachIteration =
    (process.env.LOOP_PERSIST_EACH_ITERATION || 'true').toLowerCase() !== 'false';

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
        `[run-loop] iteration #${iteration} completed: relevantNewAds=${result.relevantNewAds} removedAds=${result.removedAds} totalAds=${result.totalAds}`
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
    const timeRemaining = deadline - Date.now();
    if (timeRemaining < intervalMs + SAFETY_BUFFER_MS) {
      console.log(
        `[run-loop] not enough budget for another iteration (remaining=${Math.round(
          timeRemaining / 1000
        )}s) — exiting after ${iteration} iteration(s)`
      );
      break;
    }

    const sleepMs = Math.max(intervalMs - iterDuration, 5000);
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
