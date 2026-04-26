const cron = require('node-cron');
const { env } = require('./config/env');
const { closePool } = require('./db');
const { createApp } = require('./app');
const { ensureDatabaseReady } = require('./db/repository');
const { runScan } = require('./jobs/run-scan');

let activeScan = null;

function scheduleLocalScan() {
  if (!env.ENABLE_LOCAL_CRON) {
    return;
  }

  cron.schedule(env.SCAN_SCHEDULE, async () => {
    if (activeScan) {
      console.log('Skipping scheduled scan because another scan is still running.');
      return;
    }

    activeScan = runScan({ trigger: 'local-cron' })
      .then((result) => {
        console.log('Scheduled scan completed:', result);
      })
      .catch((error) => {
        console.error('Scheduled scan failed:', error);
      })
      .finally(() => {
        activeScan = null;
      });
  });

  console.log(`Local cron enabled with schedule ${env.SCAN_SCHEDULE}`);
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  await closePool();
  process.exit(0);
}

async function main() {
  await ensureDatabaseReady();

  const app = createApp();
  app.listen(env.PORT, () => {
    console.log(`Dashboard listening on ${env.APP_BASE_URL}`);
  });

  scheduleLocalScan();
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error(error);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error(error);
    process.exit(1);
  });
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
