'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../../database/connection');
const { authenticate } = require('../middleware/authenticate');
const BulkEmailQueue = require('../../services/queue/BulkEmailQueue');

const router = express.Router();
router.use(authenticate);

// GET /api/campaigns
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    let where = '';

    if (status) { where = `WHERE status = $1`; params.push(status); }

    const result = await db.query(
      `SELECT id, name, from_address, subject, status,
              total_recipients, sent_count, delivered_count, opened_count,
              bounced_count, failed_count, created_at, started_at, completed_at
       FROM campaigns ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), offset]
    );
    res.json({ data: result.rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns — Create campaign
router.post('/', async (req, res) => {
  const { name, from_name, from_address, reply_to, subject, body_html, body_text, track_opens, track_clicks } = req.body;
  if (!name || !from_address || !subject) {
    return res.status(400).json({ error: 'name, from_address, and subject are required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO campaigns (id, name, from_name, from_address, reply_to, subject, body_html, body_text, track_opens, track_clicks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [uuidv4(), name, from_name || name, from_address, reply_to || null,
       subject, body_html || '', body_text || '',
       track_opens !== false, track_clicks !== false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/campaigns/:id
router.put('/:id', async (req, res) => {
  const allowed = ['name', 'from_name', 'from_address', 'reply_to', 'subject', 'body_html', 'body_text', 'track_opens', 'track_clicks'];
  const updates = [];
  const params = [req.params.id];

  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${params.length + 1}`);
      params.push(req.body[field]);
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  try {
    const check = await db.query('SELECT status FROM campaigns WHERE id = $1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'scheduled'].includes(check.rows[0].status)) {
      return res.status(400).json({ error: 'Cannot edit a campaign that has started sending' });
    }

    const result = await db.query(
      `UPDATE campaigns SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      params
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/recipients — Upload recipients
router.post('/:id/recipients', async (req, res) => {
  const { recipients } = req.body; // [{ email, name, variables }]
  if (!Array.isArray(recipients) || !recipients.length) {
    return res.status(400).json({ error: 'recipients array required' });
  }

  try {
    const campaign = await db.query('SELECT id, status FROM campaigns WHERE id = $1', [req.params.id]);
    if (!campaign.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'scheduled'].includes(campaign.rows[0].status)) {
      return res.status(400).json({ error: 'Campaign already started' });
    }

    let added = 0;
    for (const r of recipients) {
      if (!r.email || !r.email.includes('@')) continue;
      await db.query(
        `INSERT INTO campaign_recipients (id, campaign_id, email, name, variables)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (campaign_id, email) DO NOTHING`,
        [uuidv4(), req.params.id, r.email.toLowerCase(), r.name || null, JSON.stringify(r.variables || {})]
      ).then(() => added++).catch(() => {});
    }

    // Update total count
    const total = await db.query('SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1', [req.params.id]);
    await db.query('UPDATE campaigns SET total_recipients = $1 WHERE id = $2',
      [parseInt(total.rows[0].count), req.params.id]);

    res.json({ added, total: parseInt(total.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/:id/recipients
router.get('/:id/recipients', async (req, res) => {
  try {
    const { status, page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;
    const params = [req.params.id];
    let statusClause = '';

    if (status) { statusClause = `AND status = $${params.length + 1}`; params.push(status); }

    const result = await db.query(
      `SELECT id, email, name, status, sent_at, opened_at, error
       FROM campaign_recipients WHERE campaign_id = $1 ${statusClause}
       ORDER BY created_at LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), offset]
    );
    res.json({ data: result.rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/send — Start sending
router.post('/:id/send', async (req, res) => {
  try {
    const campaign = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (!campaign.rows.length) return res.status(404).json({ error: 'Campaign not found' });

    const c = campaign.rows[0];
    if (c.status !== 'draft' && c.status !== 'scheduled') {
      return res.status(400).json({ error: `Campaign is already ${c.status}` });
    }

    const recipients = await db.query(
      `SELECT id, email, name, variables FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`,
      [req.params.id]
    );

    if (!recipients.rows.length) {
      return res.status(400).json({ error: 'No pending recipients' });
    }

    // Update status to sending
    await db.query('UPDATE campaigns SET status = $1, started_at = NOW() WHERE id = $2',
      ['sending', req.params.id]);

    // Queue all recipients
    const queue = BulkEmailQueue.getInstance();
    for (const recipient of recipients.rows) {
      await queue.addJob({
        campaignId: req.params.id,
        recipientId: recipient.id,
        email: recipient.email,
        name: recipient.name,
        variables: recipient.variables,
        campaign: {
          from_name: c.from_name,
          from_address: c.from_address,
          reply_to: c.reply_to,
          subject: c.subject,
          body_html: c.body_html,
          body_text: c.body_text,
        },
      });

      await db.query('UPDATE campaign_recipients SET status = $1 WHERE id = $2', ['queued', recipient.id]);
    }

    res.json({ message: 'Campaign started', queued: recipients.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/pause
router.post('/:id/pause', async (req, res) => {
  await db.query(`UPDATE campaigns SET status = 'paused' WHERE id = $1 AND status = 'sending'`, [req.params.id]);
  res.json({ message: 'Campaign paused' });
});

// POST /api/campaigns/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  await db.query(
    `UPDATE campaigns SET status = 'cancelled' WHERE id = $1 AND status IN ('draft','scheduled','paused')`,
    [req.params.id]
  );
  res.json({ message: 'Campaign cancelled' });
});

// DELETE /api/campaigns/:id
router.delete('/:id', async (req, res) => {
  const check = await db.query('SELECT status FROM campaigns WHERE id = $1', [req.params.id]);
  if (!check.rows.length) return res.status(404).json({ error: 'Campaign not found' });
  if (check.rows[0].status === 'sending') {
    return res.status(400).json({ error: 'Cannot delete a campaign that is currently sending' });
  }
  await db.query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
  res.json({ message: 'Campaign deleted' });
});

module.exports = router;
