'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../../database/connection');
const { authenticate } = require('../middleware/authenticate');

const router = express.Router();
router.use(authenticate);

// GET /api/aliases?domain_id=...
router.get('/', async (req, res) => {
  try {
    const { domain_id, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let q = `SELECT a.id, a.source_local, a.destination, a.active, a.created_at,
                    d.name AS domain_name,
                    a.source_local || '@' || d.name AS source_address
             FROM aliases a
             JOIN domains d ON d.id = a.domain_id`;
    const params = [];

    if (domain_id) {
      q += ` WHERE a.domain_id = $${params.length + 1}`;
      params.push(domain_id);
    }

    q += ` ORDER BY d.name, a.source_local LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), offset);

    const result = await db.query(q, params);
    res.json({ data: result.rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/aliases
router.post('/', async (req, res) => {
  const { domain_id, source_local, destination } = req.body;
  if (!domain_id || !source_local || !destination) {
    return res.status(400).json({ error: 'domain_id, source_local, and destination are required' });
  }
  try {
    const result = await db.query(
      `INSERT INTO aliases (id, domain_id, source_local, destination)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [uuidv4(), domain_id, source_local.toLowerCase().trim(), destination.toLowerCase().trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Alias already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/aliases/:id
router.put('/:id', async (req, res) => {
  const { destination, active } = req.body;
  try {
    const updates = [];
    const params = [req.params.id];
    if (destination !== undefined) { updates.push(`destination = $${params.length + 1}`); params.push(destination); }
    if (active !== undefined)      { updates.push(`active = $${params.length + 1}`); params.push(active); }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    const result = await db.query(
      `UPDATE aliases SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Alias not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/aliases/:id
router.delete('/:id', async (req, res) => {
  await db.query('DELETE FROM aliases WHERE id = $1', [req.params.id]);
  res.json({ message: 'Alias deleted' });
});

module.exports = router;
