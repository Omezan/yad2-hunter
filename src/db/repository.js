const { query, withClient } = require('./index');
const { initSchema } = require('./schema');

let schemaReadyPromise = null;

async function ensureDatabaseReady() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = initSchema().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }

  await schemaReadyPromise;
}

async function createRun(note) {
  const result = await query(
    `INSERT INTO runs (status, note)
     VALUES ('running', $1)
     RETURNING id, status, note, started_at`,
    [note || null]
  );

  return result.rows[0];
}

async function completeRun(runId, details) {
  await query(
    `UPDATE runs
     SET status = $2,
         completed_at = NOW(),
         total_ads = $3,
         relevant_ads = $4,
         new_ads = $5,
         errors = $6::jsonb
     WHERE id = $1`,
    [
      runId,
      details.status || 'completed',
      details.totalAds || 0,
      details.relevantAds || 0,
      details.newAds || 0,
      JSON.stringify(details.errors || [])
    ]
  );
}

async function failRun(runId, error) {
  await query(
    `UPDATE runs
     SET status = 'failed',
         completed_at = NOW(),
         errors = $2::jsonb
     WHERE id = $1`,
    [
      runId,
      JSON.stringify([
        {
          message: error.message
        }
      ])
    ]
  );
}

async function markRunNotificationSent(runId) {
  await query('UPDATE runs SET telegram_sent_at = NOW() WHERE id = $1', [runId]);
}

async function saveAndDetectNewAds(ads) {
  if (!ads.length) {
    return [];
  }

  return withClient(async (client) => {
    const externalIds = ads.map((ad) => ad.externalId);

    await client.query('BEGIN');

    try {
      const existingResult = await client.query(
        'SELECT external_id FROM seen_ads WHERE external_id = ANY($1::text[])',
        [externalIds]
      );

      const existingIds = new Set(existingResult.rows.map((row) => row.external_id));
      const newAds = [];

      for (const ad of ads) {
        if (existingIds.has(ad.externalId)) {
          await client.query(
            `UPDATE seen_ads
             SET title = $2,
                 link = $3,
                 raw_text = $4,
                 search_id = $5,
                 search_label = $6,
                 district_label = $7,
                 last_seen_at = NOW()
             WHERE external_id = $1`,
            [
              ad.externalId,
              ad.title,
              ad.link,
              ad.rawText,
              ad.searchId,
              ad.searchLabel,
              ad.districtLabel
            ]
          );
          continue;
        }

        await client.query(
          `INSERT INTO seen_ads (
            external_id,
            title,
            link,
            raw_text,
            search_id,
            search_label,
            district_label
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            ad.externalId,
            ad.title,
            ad.link,
            ad.rawText,
            ad.searchId,
            ad.searchLabel,
            ad.districtLabel
          ]
        );

        newAds.push(ad);
      }

      await client.query('COMMIT');
      return newAds;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function listRecentRuns(limit = 10) {
  const result = await query(
    `SELECT id, status, started_at, completed_at, total_ads, relevant_ads, new_ads, note, telegram_sent_at
     FROM runs
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    totalAds: Number(row.total_ads) || 0,
    relevantAds: Number(row.relevant_ads) || 0,
    newAds: Number(row.new_ads) || 0,
    note: row.note,
    telegramSentAt: row.telegram_sent_at
  }));
}

module.exports = {
  completeRun,
  createRun,
  ensureDatabaseReady,
  failRun,
  listRecentRuns,
  markRunNotificationSent,
  saveAndDetectNewAds
};
