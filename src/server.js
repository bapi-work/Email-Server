'use strict';

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./database/connection');
const { runMigrations, seedAdmin } = require('./database/migrate');

// Ensure storage directories exist
for (const dir of [config.storage.mailPath, config.storage.attachmentPath, config.dkim.keyDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function startServices() {
  // ── Database ──────────────────────────────────────────────
  logger.info('Connecting to database...');
  const dbOk = await db.testConnection();
  if (!dbOk) {
    logger.error('Database connection failed. Exiting.');
    process.exit(1);
  }

  logger.info('Running migrations...');
  await runMigrations();
  await seedAdmin();

  // ── HTTP / API server ─────────────────────────────────────
  const app = require('./api/app');
  const httpServer = http.createServer(app);

  await new Promise((resolve, reject) => {
    httpServer.listen(config.ports.http, '0.0.0.0', err => err ? reject(err) : resolve());
  });
  logger.info(`HTTP API listening on port ${config.ports.http}`);
  logger.info(`Admin panel:  http://localhost:${config.ports.http}/admin`);
  logger.info(`Webmail:      http://localhost:${config.ports.http}/webmail`);
  logger.info(`API:          http://localhost:${config.ports.http}/api`);

  // ── SMTP ─────────────────────────────────────────────────
  const SmtpServer = require('./services/smtp/SmtpServer');
  const smtpServer = new SmtpServer();
  await smtpServer.start();

  // ── IMAP ─────────────────────────────────────────────────
  const ImapServer = require('./services/imap/ImapServer');
  const imapServer = new ImapServer();
  await imapServer.start();

  // ── POP3 ─────────────────────────────────────────────────
  const Pop3Server = require('./services/pop3/Pop3Server');
  const pop3Server = new Pop3Server();
  await pop3Server.start();

  // ── Bulk email queue ──────────────────────────────────────
  const BulkEmailQueue = require('./services/queue/BulkEmailQueue');
  const queue = BulkEmailQueue.getInstance();
  queue.start();
  logger.info('Bulk email queue worker started');

  logger.info('─'.repeat(60));
  logger.info(`${config.app.name} is fully operational`);
  logger.info('─'.repeat(60));

  // ── Graceful shutdown ────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down gracefully...`);
    queue.stop();
    await smtpServer.stop();
    await imapServer.stop();
    await pop3Server.stop();
    httpServer.close(async () => {
      await db.close();
      logger.info('Shutdown complete');
      process.exit(0);
    });
    setTimeout(() => { logger.error('Forced shutdown after timeout'); process.exit(1); }, 15000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });
}

startServices().catch(err => {
  logger.error('Startup failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
