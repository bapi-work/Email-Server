'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const path = require('path');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const logger = require('../utils/logger');

// Routes
const authRoutes      = require('./routes/auth');
const domainRoutes    = require('./routes/domains');
const mailboxRoutes   = require('./routes/mailboxes');
const aliasRoutes     = require('./routes/aliases');
const messageRoutes   = require('./routes/messages');
const campaignRoutes  = require('./routes/campaigns');
const settingsRoutes  = require('./routes/settings');
const webmailRoutes   = require('./routes/webmail');

const app = express();

// ---- Security ----
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'fonts.googleapis.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com', 'cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'blob:'],
    },
  },
}));
app.use(cors({
  origin: config.app.isDev ? '*' : [config.app.adminUrl, config.app.webmailUrl],
  credentials: true,
}));
app.use(compression());

// ---- Logging ----
app.use(morgan('combined', {
  stream: { write: msg => logger.http(msg.trim()) },
  skip: (req) => req.url === '/api/health',
}));

// ---- Body parsing ----
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ---- Rate limiting ----
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.limits.rateLimitAuth,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts.' },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/webmail/auth/login', authLimiter);

// ---- Static assets ----
app.use('/admin', express.static(path.join(__dirname, '../web/admin')));
app.use('/webmail', express.static(path.join(__dirname, '../web/webmail')));

// ---- API routes ----
app.use('/api/auth',        authRoutes);
app.use('/api/domains',     domainRoutes);
app.use('/api/mailboxes',   mailboxRoutes);
app.use('/api/aliases',     aliasRoutes);
app.use('/api/messages',    messageRoutes);
app.use('/api/campaigns',   campaignRoutes);
app.use('/api/settings',    settingsRoutes);
app.use('/api/webmail',     webmailRoutes);

// ---- Health check ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: config.app.name, version: '1.0.0', time: new Date().toISOString() });
});

// ---- SPA fallback routes ----
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/admin/index.html'));
});
app.get('/webmail/*', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/webmail/index.html'));
});

// Root redirect
app.get('/', (req, res) => res.redirect('/webmail'));

// ---- Error handler ----
app.use((err, req, res, next) => {
  logger.error('API error', { error: err.message, stack: err.stack, url: req.url });
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: config.app.isDev ? err.message : 'Internal server error',
    ...(config.app.isDev && { stack: err.stack }),
  });
});

module.exports = app;
