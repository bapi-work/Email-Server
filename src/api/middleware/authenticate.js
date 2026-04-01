'use strict';

const jwt = require('jsonwebtoken');
const config = require('../../config');
const db = require('../../database/connection');

/**
 * Verify JWT token and attach user to request
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);

    // Check session in DB (allows forced logout)
    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await db.query(
      "SELECT id FROM sessions WHERE token_hash = $1 AND expires_at > NOW() AND user_type = $2",
      [tokenHash, payload.type]
    );

    if (!session.rows.length) {
      return res.status(401).json({ error: 'Session expired or revoked' });
    }

    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Admin-only access
 */
function requireAdmin(req, res, next) {
  if (req.user?.type !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Super admin only (for destructive ops)
 */
function requireSuperAdmin(req, res, next) {
  if (req.user?.type !== 'admin' || req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
  }
  next();
}

module.exports = { authenticate, requireAdmin, requireSuperAdmin };
