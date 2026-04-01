'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const db = require('../../database/connection');
const logger = require('../../utils/logger');
const { authenticate } = require('../middleware/authenticate');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts' },
});

function createToken(payload) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiry });
}

async function storeSession(token, userId, userType, ip, userAgent) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO sessions (user_id, user_type, token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, userType, tokenHash, ip, userAgent, expiresAt]
  );

  return tokenHash;
}

// POST /api/auth/admin/login
router.post('/admin/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const result = await db.query(
      'SELECT id, email, password_hash, full_name, role, active FROM admin_users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (!result.rows.length || !result.rows[0].active) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = result.rows[0];
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const payload = { id: admin.id, email: admin.email, type: 'admin', role: admin.role };
    const token = createToken(payload);

    await storeSession(token, admin.id, 'admin',
      req.ip, req.headers['user-agent']
    );

    await db.query('UPDATE admin_users SET last_login = NOW() WHERE id = $1', [admin.id]);

    logger.info('Admin login', { email: admin.email, ip: req.ip });

    res.json({
      token,
      user: { id: admin.id, email: admin.email, name: admin.full_name, role: admin.role },
    });
  } catch (err) {
    logger.error('Admin login error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/webmail/login
router.post('/webmail/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const [localPart, domain] = email.split('@');
    if (!localPart || !domain) return res.status(400).json({ error: 'Invalid email address' });

    const result = await db.query(
      `SELECT mb.id, mb.username, mb.password_hash, mb.full_name, mb.active, mb.quota_mb, mb.used_bytes,
              d.name as domain
       FROM mailboxes mb
       JOIN domains d ON d.id = mb.domain_id
       WHERE mb.username = $1 AND d.name = $2`,
      [localPart.toLowerCase(), domain.toLowerCase()]
    );

    if (!result.rows.length || !result.rows[0].active) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const mailbox = result.rows[0];
    const valid = await bcrypt.compare(password, mailbox.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const payload = {
      id: mailbox.id,
      email: `${mailbox.username}@${mailbox.domain}`,
      type: 'mailbox',
    };
    const token = createToken(payload);

    await storeSession(token, mailbox.id, 'mailbox',
      req.ip, req.headers['user-agent']
    );

    res.json({
      token,
      user: {
        id: mailbox.id,
        email: payload.email,
        name: mailbox.full_name,
        quota: { used: mailbox.used_bytes, max: mailbox.quota_mb * 1024 * 1024 },
      },
    });
  } catch (err) {
    logger.error('Webmail login error', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    const token = req.headers.authorization?.slice(7);
    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    }
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ error: 'Logout error' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    if (req.user.type === 'admin') {
      const result = await db.query(
        'SELECT id, email, full_name, role, last_login FROM admin_users WHERE id = $1',
        [req.user.id]
      );
      return res.json(result.rows[0]);
    } else {
      const result = await db.query(
        `SELECT mb.id, mb.username || '@' || d.name as email, mb.full_name, mb.quota_mb, mb.used_bytes
         FROM mailboxes mb JOIN domains d ON d.id = mb.domain_id WHERE mb.id = $1`,
        [req.user.id]
      );
      return res.json(result.rows[0]);
    }
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Both passwords required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const table = req.user.type === 'admin' ? 'admin_users' : 'mailboxes';
    const result = await db.query(`SELECT password_hash FROM ${table} WHERE id = $1`, [req.user.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await db.query(`UPDATE ${table} SET password_hash = $1 WHERE id = $2`, [newHash, req.user.id]);

    // Revoke all other sessions
    const token = req.headers.authorization?.slice(7);
    const tokenHash = token ? crypto.createHash('sha256').update(token).digest('hex') : null;
    await db.query(
      'DELETE FROM sessions WHERE user_id = $1 AND user_type = $2 AND token_hash != $3',
      [req.user.id, req.user.type, tokenHash]
    );

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
