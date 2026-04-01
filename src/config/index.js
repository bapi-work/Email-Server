'use strict';

require('dotenv').config();
const path = require('path');

const config = {
  app: {
    name: process.env.APP_NAME || 'CloudMail',
    env: process.env.NODE_ENV || 'development',
    url: process.env.APP_URL || 'http://localhost:3000',
    adminUrl: process.env.ADMIN_URL || 'http://localhost:3000/admin',
    webmailUrl: process.env.WEBMAIL_URL || 'http://localhost:3000/webmail',
    isDev: (process.env.NODE_ENV || 'development') === 'development',
  },

  ports: {
    smtp: parseInt(process.env.SMTP_PORT) || 25,
    smtpSubmission: parseInt(process.env.SMTP_SUBMISSION_PORT) || 587,
    smtpSecure: parseInt(process.env.SMTP_SECURE_PORT) || 465,
    imap: parseInt(process.env.IMAP_PORT) || 143,
    imaps: parseInt(process.env.IMAPS_PORT) || 993,
    pop3: parseInt(process.env.POP3_PORT) || 110,
    pop3s: parseInt(process.env.POP3S_PORT) || 995,
    http: parseInt(process.env.HTTP_PORT) || 3000,
  },

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    name: process.env.DB_NAME || 'cloudmail',
    user: process.env.DB_USER || 'cloudmail',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true',
    sslCa: process.env.DB_SSL_CA || null,
    pool: {
      min: parseInt(process.env.DB_POOL_MIN) || 2,
      max: parseInt(process.env.DB_POOL_MAX) || 20,
    },
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    url: process.env.REDIS_URL || null,
  },

  tls: {
    key: process.env.TLS_KEY || path.join(__dirname, '../../ssl/mail.key'),
    cert: process.env.TLS_CERT || path.join(__dirname, '../../ssl/mail.crt'),
    ca: process.env.TLS_CA || null,
    selfSigned: process.env.TLS_SELF_SIGNED === 'true',
  },

  dkim: {
    selector: process.env.DKIM_SELECTOR || 'mail',
    keyDir: process.env.DKIM_KEY_DIR || path.join(__dirname, '../../dkim-keys'),
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'INSECURE_DEV_SECRET_CHANGE_IN_PRODUCTION',
    expiry: process.env.JWT_EXPIRY || '24h',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },

  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@localhost',
    password: process.env.ADMIN_PASSWORD || 'admin',
  },

  limits: {
    maxMessageSizeMb: parseInt(process.env.MAX_MESSAGE_SIZE_MB) || 25,
    maxRecipientsPerMessage: parseInt(process.env.MAX_RECIPIENTS_PER_MESSAGE) || 100,
    maxConnectionsPerIp: parseInt(process.env.MAX_CONNECTIONS_PER_IP) || 10,
    rateLimitSmtp: parseInt(process.env.RATE_LIMIT_SMTP) || 100,
    rateLimitAuth: parseInt(process.env.RATE_LIMIT_AUTH) || 10,
    maxMailboxSizeMb: parseInt(process.env.MAX_MAILBOX_SIZE_MB) || 1024,
    maxAuthFailures: parseInt(process.env.MAX_AUTH_FAILURES) || 5,
    authBanDurationMin: parseInt(process.env.AUTH_BAN_DURATION_MIN) || 30,
  },

  bulk: {
    concurrency: parseInt(process.env.BULK_EMAIL_CONCURRENCY) || 10,
    delayMs: parseInt(process.env.BULK_EMAIL_DELAY_MS) || 100,
    fromDomain: process.env.CAMPAIGN_FROM_DOMAIN || 'localhost',
  },

  storage: {
    mailPath: process.env.MAIL_STORAGE_PATH || path.join(__dirname, '../../storage/messages'),
    attachmentPath: process.env.ATTACHMENT_STORAGE_PATH || path.join(__dirname, '../../storage/attachments'),
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || path.join(__dirname, '../../logs'),
    maxFiles: process.env.LOG_MAX_FILES || '30d',
    maxSize: process.env.LOG_MAX_SIZE || '100m',
  },

  relay: {
    host: process.env.SMTP_RELAY_HOST || null,
    port: parseInt(process.env.SMTP_RELAY_PORT) || 587,
    user: process.env.SMTP_RELAY_USER || null,
    pass: process.env.SMTP_RELAY_PASS || null,
  },

  security: {
    enableGreylisting: process.env.ENABLE_GREYLISTING === 'true',
    blockKnownSpam: process.env.BLOCK_KNOWN_SPAM !== 'false',
  },
};

module.exports = config;
