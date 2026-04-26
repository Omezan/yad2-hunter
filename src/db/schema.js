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
    CREATE TABLE IF NOT EXISTS seen_ads (
      external_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      search_id TEXT NOT NULL,
      search_label TEXT NOT NULL,
      district_label TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(
    'CREATE INDEX IF NOT EXISTS seen_ads_search_id_idx ON seen_ads (search_id, first_seen_at DESC);'
  );
}

module.exports = {
  initSchema
};
