'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../../database/connection');
const logger = require('../../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/authenticate');
const DkimService = require('../../services/dkim/DkimService');

const router = express.Router();
router.use(authenticate, requireAdmin);

// GET /api/domains
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params = [parseInt(limit), offset];

    if (search) {
      params.push(`%${search}%`);
      whereClause = `WHERE name ILIKE $${params.length}`;
    }

    const [domainsResult, countResult] = await Promise.all([
      db.query(
        `SELECT d.*,
                COUNT(mb.id) as mailbox_count,
                COUNT(a.id) as alias_count
         FROM domains d
         LEFT JOIN mailboxes mb ON mb.domain_id = d.id AND mb.active = TRUE
         LEFT JOIN aliases a ON a.domain_id = d.id AND a.active = TRUE
         ${whereClause}
         GROUP BY d.id
         ORDER BY d.name
         LIMIT $1 OFFSET $2`,
        params
      ),
      db.query(`SELECT COUNT(*) FROM domains ${whereClause}`, search ? [`%${search}%`] : []),
    ]);

    res.json({
      domains: domainsResult.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    logger.error('List domains error', { error: err.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/domains/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM domains WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Domain not found' });

    // Strip private key from response
    const domain = { ...result.rows[0], dkim_private_key: undefined };
    res.json(domain);
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/domains
router.post('/', async (req, res) => {
  try {
    const { name, description, default_quota_mb, catch_all, dmarc_policy, dmarc_rua } = req.body;

    if (!name) return res.status(400).json({ error: 'Domain name is required' });

    // Basic domain validation
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i.test(name)) {
      return res.status(400).json({ error: 'Invalid domain name' });
    }

    const result = await db.query(
      `INSERT INTO domains (name, description, default_quota_mb, catch_all, dmarc_policy, dmarc_rua)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name.toLowerCase(), description, default_quota_mb || 1024, catch_all, dmarc_policy || 'none', dmarc_rua]
    );

    logger.info('Domain created', { name, adminId: req.user.id });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Domain already exists' });
    logger.error('Create domain error', { error: err.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// PUT /api/domains/:id
router.put('/:id', async (req, res) => {
  try {
    const { description, default_quota_mb, catch_all, active, dmarc_policy, dmarc_rua, dmarc_pct } = req.body;

    const result = await db.query(
      `UPDATE domains
       SET description = COALESCE($1, description),
           default_quota_mb = COALESCE($2, default_quota_mb),
           catch_all = $3,
           active = COALESCE($4, active),
           dmarc_policy = COALESCE($5, dmarc_policy),
           dmarc_rua = $6,
           dmarc_pct = COALESCE($7, dmarc_pct),
           updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [description, default_quota_mb, catch_all, active, dmarc_policy, dmarc_rua, dmarc_pct, req.params.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Domain not found' });
    res.json({ ...result.rows[0], dkim_private_key: undefined });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/domains/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM domains WHERE id = $1 RETURNING name', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Domain not found' });
    logger.info('Domain deleted', { name: result.rows[0].name });
    res.json({ message: 'Domain deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/domains/:id/dkim/generate
router.post('/:id/dkim/generate', async (req, res) => {
  try {
    const domain = await db.query('SELECT * FROM domains WHERE id = $1', [req.params.id]);
    if (!domain.rows.length) return res.status(404).json({ error: 'Domain not found' });

    const { selector = 'mail', bits = 2048 } = req.body;
    const { privateKeyPem, publicKeyPem, publicKeyB64 } = DkimService.generateKeyPair(bits);

    await DkimService.saveKeys(domain.rows[0].name, selector, privateKeyPem, publicKeyPem, publicKeyB64);

    const dnsRecord = DkimService.getDnsTxtRecord(selector, domain.rows[0].name, publicKeyB64);

    logger.info('DKIM keys generated', { domain: domain.rows[0].name, selector });

    res.json({
      message: 'DKIM keys generated',
      selector,
      dnsRecord,
      instructions: `Add this TXT record to your DNS:\nName: ${dnsRecord.name}\nValue: ${dnsRecord.value}`,
    });
  } catch (err) {
    logger.error('DKIM generate error', { error: err.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/domains/:id/dns-records
router.get('/:id/dns-records', async (req, res) => {
  try {
    const domain = await db.query('SELECT * FROM domains WHERE id = $1', [req.params.id]);
    if (!domain.rows.length) return res.status(404).json({ error: 'Domain not found' });

    const d = domain.rows[0];
    const records = [];

    // MX record
    records.push({
      type: 'MX',
      name: d.name,
      value: `10 mail.${d.name}`,
      description: 'Mail exchanger - directs email to your server',
    });

    // A record for mail subdomain
    records.push({
      type: 'A',
      name: `mail.${d.name}`,
      value: 'YOUR_SERVER_IP',
      description: 'Points mail subdomain to your server IP',
    });

    // SPF record
    records.push({
      type: 'TXT',
      name: d.name,
      value: `v=spf1 mx a:mail.${d.name} ~all`,
      description: 'SPF record - authorizes your server to send email',
    });

    // DKIM record
    if (d.dkim_public_key && d.dkim_enabled) {
      records.push({
        type: 'TXT',
        name: `${d.dkim_selector}._domainkey.${d.name}`,
        value: `v=DKIM1; k=rsa; p=${d.dkim_public_key}`,
        description: 'DKIM public key - verifies email signatures',
      });
    }

    // DMARC record
    records.push({
      type: 'TXT',
      name: `_dmarc.${d.name}`,
      value: `v=DMARC1; p=${d.dmarc_policy || 'none'}; pct=${d.dmarc_pct || 100}${d.dmarc_rua ? `; rua=mailto:${d.dmarc_rua}` : ''}`,
      description: 'DMARC policy - tells receivers how to handle failed authentication',
    });

    // PTR / rDNS note
    records.push({
      type: 'PTR',
      name: 'YOUR_SERVER_IP',
      value: `mail.${d.name}`,
      description: 'Reverse DNS - set with your hosting provider (required for email delivery)',
      note: 'Configure in your VPS/cloud provider control panel',
    });

    res.json({ domain: d.name, records });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/domains/:id/verify-dns
router.get('/:id/verify-dns', async (req, res) => {
  try {
    const domain = await db.query('SELECT * FROM domains WHERE id = $1', [req.params.id]);
    if (!domain.rows.length) return res.status(404).json({ error: 'Domain not found' });

    const dns = require('dns').promises;
    const d = domain.rows[0];
    const checks = {};

    // Check MX
    try {
      const mx = await dns.resolveMx(d.name);
      checks.mx = { ok: mx.length > 0, records: mx };
    } catch {
      checks.mx = { ok: false, records: [] };
    }

    // Check SPF
    try {
      const txt = await dns.resolveTxt(d.name);
      const spf = txt.flat().find(r => r.startsWith('v=spf1'));
      checks.spf = { ok: !!spf, value: spf || null };
    } catch {
      checks.spf = { ok: false, value: null };
    }

    // Check DKIM
    if (d.dkim_selector) {
      try {
        const dkimTxt = await dns.resolveTxt(`${d.dkim_selector}._domainkey.${d.name}`);
        const dkim = dkimTxt.flat().find(r => r.startsWith('v=DKIM1'));
        checks.dkim = { ok: !!dkim, value: dkim || null };
      } catch {
        checks.dkim = { ok: false, value: null };
      }
    }

    // Check DMARC
    try {
      const dmarcTxt = await dns.resolveTxt(`_dmarc.${d.name}`);
      const dmarc = dmarcTxt.flat().find(r => r.startsWith('v=DMARC1'));
      checks.dmarc = { ok: !!dmarc, value: dmarc || null };
    } catch {
      checks.dmarc = { ok: false, value: null };
    }

    res.json({ domain: d.name, checks });
  } catch (err) {
    res.status(500).json({ error: 'DNS verification error' });
  }
});

module.exports = router;
