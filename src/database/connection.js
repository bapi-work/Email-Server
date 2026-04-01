'use strict';

const { Pool } = require('pg');
const config = require('../config');
const logger = require('../utils/logger');

const sslConfig = config.db.ssl
  ? {
      ssl: {
        rejectUnauthorized: true,
        ...(config.db.sslCa && { ca: require('fs').readFileSync(config.db.sslCa).toString() }),
      },
    }
  : {};

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  min: config.db.pool.min,
  max: config.db.pool.max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ...sslConfig,
});

pool.on('connect', () => {
  logger.debug('Database pool connection established');
});

pool.on('error', (err) => {
  logger.error('Database pool error', { error: err.message });
});

/**
 * Execute a query with optional parameters
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Query executed', { duration, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('Query error', { error: err.message, query: text });
    throw err;
  }
}

/**
 * Get a client from the pool (for transactions)
 */
async function getClient() {
  return pool.connect();
}

/**
 * Execute multiple queries in a transaction
 */
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Test the database connection
 */
async function testConnection() {
  try {
    const result = await pool.query('SELECT NOW() as time, version() as version');
    logger.info('Database connected', {
      time: result.rows[0].time,
      version: result.rows[0].version.split(' ').slice(0, 2).join(' '),
    });
    return true;
  } catch (err) {
    logger.error('Database connection failed', { error: err.message });
    return false;
  }
}

/**
 * Close the pool
 */
async function close() {
  await pool.end();
  logger.info('Database pool closed');
}

module.exports = { query, getClient, transaction, testConnection, close, pool };
