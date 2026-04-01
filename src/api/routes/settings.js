'use strict';

const express = require('express');
const db = require('../../database/connection');
const { authenticate } = require('../middleware/authenticate');
const DkimService = require('../../services/dkim/DkimService');
const { SpfService, DmarcService } = require('../../services/spf/SpfService');

const router = express.Router();
router.use(authenticate);

// GET /api/settings/dns/:domainId — Get DNS record recommendations
router.get('/dns/:domainId', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM domains WHERE id = $1', [req.params.domainId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Domain not found' });

    const domain = result.rows[0];
    const serverIp = req.headers['x-server-ip'] || 'YOUR_SERVER_IP';

    const records = {
      mx: {
        type: 'MX',
        host: domain.name,
        priority: 10,
        value: `mail.${domain.name}`,
        ttl: 3600,
        description: 'Mail exchanger — points email to your mail server',
      },
      a: {
        type: 'A',
        host: `mail.${domain.name}`,
        value: serverIp,
        ttl: 3600,
        description: 'A record for your mail server hostname',
      },
      spf: {
        type: 'TXT',
        host: domain.name,
        value: SpfService.generateRecord({ serverIp, policy: 'softfail' }),
        ttl: 3600,
        description: 'SPF — authorizes your server to send email for this domain',
      },
      dkim: {
        type: 'TXT',
        host: `${domain.dkim_selector || 'mail'}._domainkey.${domain.name}`,
        value: domain.dkim_public_key
          ? `v=DKIM1; k=rsa; p=${domain.dkim_public_key}`
          : '(Generate DKIM keys first)',
        ttl: 3600,
        description: 'DKIM public key — allows receivers to verify your email signature',
      },
      dmarc: {
        type: 'TXT',
        host: `_dmarc.${domain.name}`,
        value: DmarcService.generateRecord({
          policy: domain.dmarc_policy || 'none',
          ruaEmail: domain.dmarc_rua || `dmarc-reports@${domain.name}`,
          pct: domain.dmarc_pct || 100,
        }),
        ttl: 3600,
        description: 'DMARC — defines policy for authentication failures',
      },
      rdns: {
        type: 'PTR (Reverse DNS)',
        host: serverIp,
        value: `mail.${domain.name}`,
        ttl: 3600,
        description: 'Reverse DNS — configure at your hosting provider; critical for email deliverability',
      },
    };

    res.json({ domain: domain.name, records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/dkim/generate/:domainId — Generate DKIM key pair
router.post('/dkim/generate/:domainId', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM domains WHERE id = $1', [req.params.domainId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Domain not found' });

    const { privateKeyPem, publicKeyDns } = DkimService.generateKeyPair(2048);

    await db.query(
      `UPDATE domains SET dkim_private_key = $1, dkim_public_key = $2, dkim_enabled = TRUE WHERE id = $3`,
      [privateKeyPem, publicKeyDns, req.params.domainId]
    );

    res.json({
      message: 'DKIM keys generated',
      dnsRecord: {
        host: `${result.rows[0].dkim_selector || 'mail'}._domainkey.${result.rows[0].name}`,
        value: `v=DKIM1; k=rsa; p=${publicKeyDns}`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/blocklist
router.get('/blocklist', async (req, res) => {
  const { type, page = 1, limit = 100 } = req.query;
  const offset = (page - 1) * limit;
  const params = [];
  let where = '';

  if (type) { where = `WHERE type = $1`; params.push(type); }

  const result = await db.query(
    `SELECT * FROM blocklist ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, parseInt(limit), offset]
  );
  res.json({ data: result.rows });
});

// POST /api/settings/blocklist
router.post('/blocklist', async (req, res) => {
  const { type, value, reason } = req.body;
  if (!type || !value) return res.status(400).json({ error: 'type and value required' });
  if (!['email', 'domain', 'ip'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

  try {
    const { v4: uuidv4 } = require('uuid');
    const result = await db.query(
      'INSERT INTO blocklist (id, type, value, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *',
      [uuidv4(), type, value.toLowerCase().trim(), reason || null]
    );
    res.status(201).json(result.rows[0] || { message: 'Already exists' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/blocklist/:id
router.delete('/blocklist/:id', async (req, res) => {
  await db.query('DELETE FROM blocklist WHERE id = $1', [req.params.id]);
  res.json({ message: 'Removed from blocklist' });
});

// GET /api/settings/stats — Dashboard statistics
router.get('/stats', async (req, res) => {
  try {
    const [domains, mailboxes, messages, campaigns, smtpToday] = await Promise.all([
      db.query('SELECT COUNT(*) FROM domains WHERE active = TRUE'),
      db.query('SELECT COUNT(*) FROM mailboxes WHERE active = TRUE'),
      db.query('SELECT COUNT(*) FROM messages WHERE is_deleted = FALSE'),
      db.query("SELECT COUNT(*) FROM campaigns WHERE status NOT IN ('cancelled')"),
      db.query(`SELECT status, COUNT(*) FROM smtp_logs WHERE logged_at >= NOW() - INTERVAL '24h' GROUP BY status`),
    ]);

    const smtpStats = {};
    for (const row of smtpToday.rows) smtpStats[row.status] = parseInt(row.count);

    res.json({
      domains: parseInt(domains.rows[0].count),
      mailboxes: parseInt(mailboxes.rows[0].count),
      messages: parseInt(messages.rows[0].count),
      campaigns: parseInt(campaigns.rows[0].count),
      smtp24h: smtpStats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/admin-users
router.get('/admin-users', async (req, res) => {
  const result = await db.query(
    'SELECT id, email, full_name, role, active, last_login, created_at FROM admin_users ORDER BY created_at'
  );
  res.json(result.rows);
});

// POST /api/settings/admin-users
router.post('/admin-users', async (req, res) => {
  const { email, password, full_name, role } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');
    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      `INSERT INTO admin_users (id, email, password_hash, full_name, role)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, email, full_name, role`,
      [uuidv4(), email.toLowerCase(), hash, full_name || null, role || 'admin']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
