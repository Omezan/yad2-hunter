const { Pool } = require('pg');
const { env } = require('../config/env');

let pool;

function shouldUseSsl(connectionString) {
  if (!connectionString) {
    return false;
  }

  const hostname = new URL(connectionString).hostname;
  return !['localhost', '127.0.0.1'].includes(hostname);
}

function getPool() {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: shouldUseSsl(env.DATABASE_URL) ? { rejectUnauthorized: false } : false
    });
  }

  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function withClient(callback) {
  const client = await getPool().connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  closePool,
  getPool,
  query,
  withClient
};
