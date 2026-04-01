'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../database/connection');
const logger = require('../../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/authenticate');

const router = express.Router();
router.use(authenticate, requireAdmin);

// GET /api/mailboxes
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, domain, search } = req.query;
    const offset = (page - 1) * limit;
    const params = [parseInt(limit), offset];
    const conditions = [];

    if (domain) {
      params.push(domain);
      conditions.push(`d.name = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(mb.username ILIKE $${params.length} OR mb.full_name ILIKE $${params.length})`);
    }

    const whereStr = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [result, countResult] = await Promise.all([
      db.query(
        `SELECT mb.id, mb.username, mb.full_name, mb.quota_mb, mb.used_bytes,
                mb.active, mb.can_send, mb.can_receive, mb.created_at,
                d.name as domain,
                mb.username || '@' || d.name as email
         FROM mailboxes mb JOIN domains d ON d.id = mb.domain_id
         ${whereStr}
         ORDER BY d.name, mb.username
         LIMIT $1 OFFSET $2`,
        params
      ),
      db.query(`SELECT COUNT(*) FROM mailboxes mb JOIN domains d ON d.id = mb.domain_id ${whereStr}`,
        params.slice(2)),
    ]);

    res.json({
      mailboxes: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/mailboxes/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT mb.*, d.name as domain, mb.username || '@' || d.name as email
       FROM mailboxes mb JOIN domains d ON d.id = mb.domain_id WHERE mb.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mailbox not found' });
    const mb = { ...result.rows[0], password_hash: undefined };
    res.json(mb);
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/mailboxes
router.post('/', async (req, res) => {
  try {
    const { username, domain, password, full_name, quota_mb, can_send, can_receive } = req.body;

    if (!username || !domain || !password) {
      return res.status(400).json({ error: 'username, domain, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!/^[a-z0-9._%+-]+$/i.test(username)) {
      return res.status(400).json({ error: 'Invalid username' });
    }

    const domainResult = await db.query(
      'SELECT id, default_quota_mb FROM domains WHERE name = $1 AND active = TRUE',
      [domain.toLowerCase()]
    );
    if (!domainResult.rows.length) return res.status(404).json({ error: 'Domain not found' });

    const hash = await bcrypt.hash(password, 12);
    const effectiveQuota = quota_mb || domainResult.rows[0].default_quota_mb;

    const result = await db.query(
      `INSERT INTO mailboxes (domain_id, username, password_hash, full_name, quota_mb, can_send, can_receive)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, username, full_name, quota_mb, active`,
      [
        domainResult.rows[0].id,
        username.toLowerCase(),
        hash,
        full_name || null,
        effectiveQuota,
        can_send !== false,
        can_receive !== false,
      ]
    );

    // Create default folders
    const mailboxId = result.rows[0].id;
    const defaultFolders = [
      { name: 'INBOX', special_use: '\\Inbox' },
      { name: 'Sent', special_use: '\\Sent' },
      { name: 'Drafts', special_use: '\\Drafts' },
      { name: 'Trash', special_use: '\\Trash' },
      { name: 'Spam', special_use: '\\Junk' },
    ];

    for (const folder of defaultFolders) {
      await db.query(
        'INSERT INTO folders (mailbox_id, name, special_use) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [mailboxId, folder.name, folder.special_use]
      );
    }

    logger.info('Mailbox created', { email: `${username}@${domain}` });
    res.status(201).json({ ...result.rows[0], email: `${username}@${domain}` });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Mailbox already exists' });
    logger.error('Create mailbox error', { error: err.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// PUT /api/mailboxes/:id
router.put('/:id', async (req, res) => {
  try {
    const { full_name, quota_mb, active, can_send, can_receive } = req.body;

    const result = await db.query(
      `UPDATE mailboxes
       SET full_name = COALESCE($1, full_name),
           quota_mb = COALESCE($2, quota_mb),
           active = COALESCE($3, active),
           can_send = COALESCE($4, can_send),
           can_receive = COALESCE($5, can_receive),
           updated_at = NOW()
       WHERE id = $6 RETURNING id, username, full_name, quota_mb, active, can_send, can_receive`,
      [full_name, quota_mb, active, can_send, can_receive, req.params.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Mailbox not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/mailboxes/:id/reset-password
router.post('/:id/reset-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      'UPDATE mailboxes SET password_hash = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
      [hash, req.params.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Mailbox not found' });

    // Revoke active sessions
    await db.query(
      "DELETE FROM sessions WHERE user_id = $1 AND user_type = 'mailbox'",
      [req.params.id]
    );

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/mailboxes/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM mailboxes WHERE id = $1 RETURNING username',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mailbox not found' });
    logger.info('Mailbox deleted', { username: result.rows[0].username });
    res.json({ message: 'Mailbox deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/mailboxes/:id/stats
router.get('/:id/stats', async (req, res) => {
  try {
    const stats = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE NOT is_deleted) as total_messages,
         COUNT(*) FILTER (WHERE NOT is_seen AND NOT is_deleted) as unread,
         COUNT(*) FILTER (WHERE is_flagged AND NOT is_deleted) as flagged,
         SUM(size_bytes) FILTER (WHERE NOT is_deleted) as total_size
       FROM messages WHERE mailbox_id = $1`,
      [req.params.id]
    );

    const quota = await db.query('SELECT quota_mb, used_bytes FROM mailboxes WHERE id = $1', [req.params.id]);
    if (!quota.rows.length) return res.status(404).json({ error: 'Mailbox not found' });

    res.json({
      ...stats.rows[0],
      quota_mb: quota.rows[0].quota_mb,
      used_bytes: parseInt(quota.rows[0].used_bytes),
      usage_percent: Math.round((quota.rows[0].used_bytes / (quota.rows[0].quota_mb * 1024 * 1024)) * 100),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
