const { query } = require('./index');

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS runs (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      total_ads INTEGER NOT NULL DEFAULT 0,
      relevant_ads INTEGER NOT NULL DEFAULT 0,
      new_ads INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      telegram_sent_at TIMESTAMPTZ
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ads (
      id BIGSERIAL PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      location_text TEXT,
      district_key TEXT NOT NULL,
      district_label TEXT NOT NULL,
      search_id TEXT NOT NULL,
      search_label TEXT NOT NULL,
      source_url TEXT NOT NULL,
      price INTEGER,
      rooms NUMERIC(4, 1),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS run_ads (
      run_id BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      ad_id BIGINT NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
      PRIMARY KEY (run_id, ad_id)
    );
  `);

  await query(
    'CREATE INDEX IF NOT EXISTS ads_district_key_idx ON ads (district_key, first_seen_at DESC);'
  );
  await query('CREATE INDEX IF NOT EXISTS ads_search_id_idx ON ads (search_id, first_seen_at DESC);');
  await query('CREATE INDEX IF NOT EXISTS run_ads_ad_id_idx ON run_ads (ad_id);');
}

module.exports = {
  initSchema
};
