const { query, withClient } = require('./index');
const { initSchema } = require('./schema');

function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return Number(value);
}

function buildAdFilters(filters = {}, startingIndex = 1, alias = 'a') {
  const clauses = [];
  const params = [];
  let index = startingIndex;

  if (filters.districtKey) {
    clauses.push(`${alias}.district_key = $${index++}`);
    params.push(filters.districtKey);
  }

  if (filters.searchId) {
    clauses.push(`${alias}.search_id = $${index++}`);
    params.push(filters.searchId);
  }

  if (filters.q) {
    clauses.push(
      `(${alias}.title ILIKE $${index} OR ${alias}.raw_text ILIKE $${index} OR ${alias}.location_text ILIKE $${index})`
    );
    params.push(`%${filters.q}%`);
    index += 1;
  }

  if (filters.minPrice !== null && filters.minPrice !== undefined) {
    clauses.push(`${alias}.price >= $${index++}`);
    params.push(filters.minPrice);
  }

  if (filters.maxPrice !== null && filters.maxPrice !== undefined) {
    clauses.push(`${alias}.price <= $${index++}`);
    params.push(filters.maxPrice);
  }

  if (filters.minRooms !== null && filters.minRooms !== undefined) {
    clauses.push(`${alias}.rooms >= $${index++}`);
    params.push(filters.minRooms);
  }

  if (filters.maxRooms !== null && filters.maxRooms !== undefined) {
    clauses.push(`${alias}.rooms <= $${index++}`);
    params.push(filters.maxRooms);
  }

  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    nextIndex: index
  };
}

function mapAdRow(row) {
  return {
    id: row.id,
    externalId: row.external_id,
    title: row.title,
    link: row.link,
    rawText: row.raw_text,
    locationText: row.location_text,
    districtKey: row.district_key,
    districtLabel: row.district_label,
    searchId: row.search_id,
    searchLabel: row.search_label,
    sourceUrl: row.source_url,
    price: row.price,
    rooms: row.rooms === null ? null : Number(row.rooms),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  };
}

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

async function upsertRelevantAds(ads) {
  if (!ads.length) {
    return [];
  }

  return withClient(async (client) => {
    const externalIds = ads.map((ad) => ad.externalId);

    await client.query('BEGIN');

    try {
      const existingResult = await client.query(
        'SELECT id, external_id FROM ads WHERE external_id = ANY($1::text[])',
        [externalIds]
      );

      const existingIds = new Map(
        existingResult.rows.map((row) => [row.external_id, row.id])
      );
      const newAds = [];

      for (const ad of ads) {
        if (existingIds.has(ad.externalId)) {
          await client.query(
            `UPDATE ads
             SET title = $2,
                 link = $3,
                 raw_text = $4,
                 location_text = $5,
                 district_key = $6,
                 district_label = $7,
                 search_id = $8,
                 search_label = $9,
                 source_url = $10,
                 price = $11,
                 rooms = $12,
                 last_seen_at = NOW()
             WHERE external_id = $1`,
            [
              ad.externalId,
              ad.title,
              ad.link,
              ad.rawText,
              ad.locationText,
              ad.districtKey,
              ad.districtLabel,
              ad.searchId,
              ad.searchLabel,
              ad.sourceUrl,
              ad.price,
              ad.rooms
            ]
          );
          continue;
        }

        const inserted = await client.query(
          `INSERT INTO ads (
            external_id,
            title,
            link,
            raw_text,
            location_text,
            district_key,
            district_label,
            search_id,
            search_label,
            source_url,
            price,
            rooms
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING *`,
          [
            ad.externalId,
            ad.title,
            ad.link,
            ad.rawText,
            ad.locationText,
            ad.districtKey,
            ad.districtLabel,
            ad.searchId,
            ad.searchLabel,
            ad.sourceUrl,
            ad.price,
            ad.rooms
          ]
        );

        newAds.push(mapAdRow(inserted.rows[0]));
      }

      await client.query('COMMIT');
      return newAds;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function attachAdsToRun(runId, adIds) {
  if (!adIds.length) {
    return;
  }

  await withClient(async (client) => {
    await client.query('BEGIN');

    try {
      for (const adId of adIds) {
        await client.query(
          'INSERT INTO run_ads (run_id, ad_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [runId, adId]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function getDashboardSummary() {
  const result = await query(
    `SELECT
      (SELECT COUNT(*) FROM ads) AS total_ads,
      (SELECT COUNT(*) FROM runs) AS total_runs,
      (SELECT COUNT(*) FROM runs WHERE new_ads > 0) AS runs_with_updates,
      (SELECT COALESCE(SUM(new_ads), 0) FROM runs) AS total_new_ads`
  );

  const row = result.rows[0];
  return {
    totalAds: toNumber(row.total_ads) || 0,
    totalRuns: toNumber(row.total_runs) || 0,
    runsWithUpdates: toNumber(row.runs_with_updates) || 0,
    totalNewAds: toNumber(row.total_new_ads) || 0
  };
}

async function listRecentRuns(limit = 20) {
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
    totalAds: toNumber(row.total_ads) || 0,
    relevantAds: toNumber(row.relevant_ads) || 0,
    newAds: toNumber(row.new_ads) || 0,
    note: row.note,
    telegramSentAt: row.telegram_sent_at
  }));
}

async function listAds(filters = {}, options = {}) {
  const limit = options.limit || 50;
  const runId = options.runId || null;
  const joinClause = runId ? 'INNER JOIN run_ads ra ON ra.ad_id = a.id' : '';
  const baseFilters = buildAdFilters(filters, runId ? 2 : 1);
  const whereParts = [];
  const params = [];

  if (runId) {
    whereParts.push('ra.run_id = $1');
    params.push(runId);
  }

  if (baseFilters.sql) {
    whereParts.push(baseFilters.sql.replace(/^WHERE\s+/i, ''));
    params.push(...baseFilters.params);
  }

  params.push(limit);

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const result = await query(
    `SELECT a.*
     FROM ads a
     ${joinClause}
     ${whereClause}
     ORDER BY a.first_seen_at DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows.map(mapAdRow);
}

async function getRun(runId) {
  const result = await query(
    `SELECT id, status, started_at, completed_at, total_ads, relevant_ads, new_ads, note, errors, telegram_sent_at
     FROM runs
     WHERE id = $1`,
    [runId]
  );

  if (!result.rows[0]) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    totalAds: toNumber(row.total_ads) || 0,
    relevantAds: toNumber(row.relevant_ads) || 0,
    newAds: toNumber(row.new_ads) || 0,
    note: row.note,
    errors: row.errors || [],
    telegramSentAt: row.telegram_sent_at
  };
}

module.exports = {
  attachAdsToRun,
  completeRun,
  createRun,
  ensureDatabaseReady,
  failRun,
  getDashboardSummary,
  getRun,
  listAds,
  listRecentRuns,
  markRunNotificationSent,
  upsertRelevantAds
};
