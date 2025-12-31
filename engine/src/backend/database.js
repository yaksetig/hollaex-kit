const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const buildConnectionString = (config) => {
  const connectionString = config.connectionString || config.url;
  if (connectionString) return connectionString;

  const auth = `${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}`;
  const database = config.database || config.name;
  return `postgresql://${auth}@${config.host}:${config.port}/${database}`;
};

const createPool = (config) => {
  return new Pool({
    connectionString: buildConnectionString(config),
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: config.connectionTimeoutMs,
  });
};

const expandIncludes = (sql, baseDir) => {
  return sql
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('\\i ')) {
        const includePath = trimmed.replace('\\i', '').trim().replace(/^['"]|['"]$/g, '');
        const resolved = path.resolve(baseDir, includePath);
        return fs.readFileSync(resolved, 'utf-8');
      }
      return line;
    })
    .join('\n');
};

const runMigrations = async (pool, migrationsDir) => {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())'
    );

    for (const file of files) {
      const version = path.basename(file, '.sql');
      const alreadyApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (alreadyApplied.rowCount) continue;

      const raw = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      const sql = expandIncludes(raw, migrationsDir);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const verifyConnectivity = async (pool) => {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
};

module.exports = {
  buildConnectionString,
  createPool,
  runMigrations,
  verifyConnectivity,
};
