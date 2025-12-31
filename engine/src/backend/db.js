const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');

const MIGRATIONS_TABLE = 'schema_migrations';

class Database {
  constructor() {
    const { connectionString, ...dbConfig } = config.db;
    this.pool = new Pool(connectionString ? { connectionString } : dbConfig);
  }

  async query(text, params = []) {
    const client = await this.pool.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }

  async withTransaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureMigrationsTable(client) {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );
  }

  async getAppliedMigrations(client) {
    await this.ensureMigrationsTable(client);
    const result = await client.query(`SELECT name FROM ${MIGRATIONS_TABLE}`);
    return new Set(result.rows.map((row) => row.name));
  }

  async runMigrations() {
    const client = await this.pool.connect();
    try {
      await this.ensureMigrationsTable(client);
      const migrationsDir = config.paths.migrationsDir;
      const files = fs
        .readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'))
        .sort();

      const applied = await this.getAppliedMigrations(client);

      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`, [file]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { Database };
