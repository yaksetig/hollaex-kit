const { createPool, runMigrations, verifyConnectivity } = require('./database');
const config = require('./config');

const seedAdmin = async (pool) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [config.seeding.adminEmail]);
    const userId = rows[0]?.id;
    let id = userId;
    if (!userId) {
      const inserted = await client.query('INSERT INTO users (email) VALUES ($1) RETURNING id', [config.seeding.adminEmail]);
      id = inserted.rows[0].id;
    }

    const balances = config.seeding.seedBalances;
    for (const [currency, amount] of Object.entries(balances)) {
      await client.query(
        `INSERT INTO balances (user_id, currency, total, available)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (user_id, currency) DO UPDATE SET total = EXCLUDED.total, available = EXCLUDED.available`,
        [id, currency, amount]
      );
    }

    await client.query('COMMIT');
    return { adminUserId: id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const initialize = async () => {
  const pool = createPool(config.db);
  await verifyConnectivity(pool);
  await runMigrations(pool, config.paths.migrationsDir);
  await seedAdmin(pool);
  return pool;
};

if (require.main === module) {
  initialize()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('Startup routine completed');
      process.exit(0);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Startup routine failed', error);
      process.exit(1);
    });
}

module.exports = { initialize };
