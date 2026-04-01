'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./connection');
const logger = require('../utils/logger');

async function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');

  logger.info('Running database migrations...');

  // Ensure schema_migrations table exists (bootstrap)
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(50) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const applied = await db.query('SELECT version FROM schema_migrations');
  const appliedVersions = new Set(applied.rows.map(r => r.version));

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = file.replace('.sql', '');
    if (appliedVersions.has(version)) {
      logger.debug(`Migration already applied: ${version}`);
      continue;
    }

    logger.info(`Applying migration: ${version}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    try {
      await db.query(sql);
      logger.info(`Migration applied: ${version}`);
    } catch (err) {
      logger.error(`Migration failed: ${version}`, { error: err.message });
      throw err;
    }
  }

  logger.info('All migrations complete');
}

async function seedAdmin() {
  const bcrypt = require('bcryptjs');
  const config = require('../config');

  const existing = await db.query(
    'SELECT id FROM admin_users WHERE email = $1',
    [config.admin.email]
  );

  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash(config.admin.password, 12);
    await db.query(
      `INSERT INTO admin_users (email, password_hash, full_name, role)
       VALUES ($1, $2, 'System Administrator', 'superadmin')`,
      [config.admin.email, hash]
    );
    logger.info(`Admin user created: ${config.admin.email}`);
  }
}

if (require.main === module) {
  (async () => {
    try {
      await runMigrations();
      await seedAdmin();
      process.exit(0);
    } catch (err) {
      logger.error('Migration failed', { error: err.message });
      process.exit(1);
    } finally {
      await db.close();
    }
  })();
}

module.exports = { runMigrations, seedAdmin };
