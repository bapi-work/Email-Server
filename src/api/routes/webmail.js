'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../../database/connection');
const config = require('../../config');
const logger = require('../../utils/logger');

const router = express.Router();

// ---- Webmail auth middleware ----
function webmailAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, config.jwt.secret);
    if (payload.type !== 'mailbox') return res.status(401).json({ error: 'Invalid token type' });
    req.user = payload;
    req.token = token;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// POST /api/webmail/auth/login
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    let localPart = email, domainName = null;
    if (email.includes('@')) [localPart, domainName] = email.split('@');

    let q = `SELECT m.id, m.username, m.password_hash, m.full_name, m.active, m.can_send, m.quota_mb,
                    d.name AS domain
             FROM mailboxes m JOIN domains d ON d.id = m.domain_id
             WHERE m.username = $1 AND m.active = TRUE AND d.active = TRUE`;
    const params = [localPart];
    if (domainName) { q += ' AND d.name = $2'; params.push(domainName); }

    const result = await db.query(q, params);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { sub: user.id, type: 'mailbox', username: user.username, domain: user.domain },
      config.jwt.secret,
      { expiresIn: config.jwt.expiry }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: `${user.username}@${user.domain}`,
        name: user.full_name,
        quotaMb: user.quota_mb,
        canSend: user.can_send,
      },
    });
  } catch (err) {
    logger.error('Webmail login error', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/webmail/auth/logout
router.post('/auth/logout', webmailAuth, (req, res) => res.json({ message: 'Logged out' }));

// GET /api/webmail/profile
router.get('/profile', webmailAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT m.id, m.username, m.full_name, m.quota_mb, m.used_bytes, m.can_send, m.created_at,
              d.name AS domain
       FROM mailboxes m JOIN domains d ON d.id = m.domain_id WHERE m.id = $1`,
      [req.user.sub]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mailbox not found' });
    const u = result.rows[0];
    res.json({ ...u, email: `${u.username}@${u.domain}` });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// PUT /api/webmail/profile/password
router.put('/profile/password', webmailAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const result = await db.query('SELECT password_hash FROM mailboxes WHERE id = $1', [req.user.sub]);
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

  const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

  const hash = await bcrypt.hash(newPassword, 12);
  await db.query('UPDATE mailboxes SET password_hash = $1 WHERE id = $2', [hash, req.user.sub]);
  res.json({ message: 'Password updated' });
});

// GET /api/webmail/folders
router.get('/folders', webmailAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, special_use, subscribed, total_msgs, unseen_msgs
       FROM folders WHERE mailbox_id = $1
       ORDER BY CASE name WHEN 'INBOX' THEN 0 WHEN 'Sent' THEN 1 WHEN 'Drafts' THEN 2 WHEN 'Trash' THEN 3 WHEN 'Spam' THEN 4 ELSE 5 END, name`,
      [req.user.sub]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/webmail/messages?folder=INBOX&page=1&search=...
router.get('/messages', webmailAuth, async (req, res) => {
  try {
    const { folder = 'INBOX', page = 1, limit = 50, search, flags } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const folderResult = await db.query(
      'SELECT id FROM folders WHERE mailbox_id = $1 AND name = $2',
      [req.user.sub, folder]
    );
    if (!folderResult.rows.length) return res.status(404).json({ error: 'Folder not found' });

    const folderId = folderResult.rows[0].id;
    const params = [req.user.sub, folderId];
    const conditions = ['m.mailbox_id = $1', 'm.folder_id = $2', 'NOT m.is_deleted'];

    if (search) {
      params.push(`%${search}%`);
      const p = params.length;
      conditions.push(`(m.subject ILIKE $${p} OR m.from_address ILIKE $${p} OR m.from_name ILIKE $${p})`);
    }
    if (flags === 'unread')   conditions.push('NOT m.is_seen');
    if (flags === 'flagged')  conditions.push('m.is_flagged');

    const where = conditions.join(' AND ');
    params.push(parseInt(limit), offset);

    const [msgs, cnt] = await Promise.all([
      db.query(
        `SELECT m.id, m.uid, m.subject, m.from_address, m.from_name, m.to_addresses,
                m.size_bytes, m.is_seen, m.is_flagged, m.is_answered, m.is_draft,
                m.has_attachments, m.received_at
         FROM messages m WHERE ${where}
         ORDER BY m.received_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      db.query(`SELECT COUNT(*) FROM messages m WHERE ${where}`, params.slice(0, -2)),
    ]);

    res.json({
      messages: msgs.rows,
      total: parseInt(cnt.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/webmail/messages/:id
router.get('/messages/:id', webmailAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT m.*, f.name AS folder_name
       FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.id = $1 AND m.mailbox_id = $2`,
      [req.params.id, req.user.sub]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });

    const msg = result.rows[0];

    // Mark as read
    if (!msg.is_seen) {
      await db.query('UPDATE messages SET is_seen = TRUE WHERE id = $1', [msg.id]);
      await db.query('UPDATE folders SET unseen_msgs = GREATEST(0, unseen_msgs - 1) WHERE id = $1', [msg.folder_id]);
    }

    const attachments = await db.query(
      'SELECT id, filename, content_type, size_bytes, inline FROM attachments WHERE message_id = $1',
      [msg.id]
    );

    res.json({ ...msg, attachments: attachments.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/webmail/messages — Send or save draft
router.post('/messages', webmailAuth, async (req, res) => {
  try {
    const { to, cc, bcc, subject, bodyHtml, bodyText, isDraft } = req.body;

    if (!isDraft && (!to || !subject)) {
      return res.status(400).json({ error: 'To and subject required for sending' });
    }

    const mbResult = await db.query(
      `SELECT mb.*, d.name AS domain FROM mailboxes mb
       JOIN domains d ON d.id = mb.domain_id WHERE mb.id = $1`,
      [req.user.sub]
    );
    if (!mbResult.rows.length) return res.status(403).json({ error: 'Mailbox not found' });

    const mb = mbResult.rows[0];
    const fromEmail = `${mb.username}@${mb.domain}`;

    if (isDraft) {
      const draftFolder = await db.query(
        "SELECT id, uid_next FROM folders WHERE mailbox_id = $1 AND name = 'Drafts'",
        [req.user.sub]
      );
      if (!draftFolder.rows.length) {
        await db.query(
          "INSERT INTO folders (mailbox_id, name, special_use) VALUES ($1, 'Drafts', '\\Drafts') ON CONFLICT DO NOTHING",
          [req.user.sub]
        );
      }
      const df = (await db.query("SELECT id, uid_next FROM folders WHERE mailbox_id = $1 AND name = 'Drafts'", [req.user.sub])).rows[0];
      const uid = df.uid_next;
      await db.query('UPDATE folders SET uid_next = uid_next + 1, total_msgs = total_msgs + 1 WHERE id = $1', [df.id]);
      const saved = await db.query(
        `INSERT INTO messages (mailbox_id, folder_id, uid, subject, from_address, to_addresses,
          cc_addresses, body_html, body_text, is_draft, is_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,TRUE) RETURNING id`,
        [req.user.sub, df.id, uid, subject || '', fromEmail,
         JSON.stringify(Array.isArray(to) ? to : (to ? [to] : [])),
         JSON.stringify(Array.isArray(cc) ? cc : (cc ? [cc] : [])),
         bodyHtml || '', bodyText || '']
      );
      return res.status(201).json({ id: saved.rows[0].id, message: 'Draft saved' });
    }

    if (!mb.can_send) return res.status(403).json({ error: 'Sending disabled for this account' });

    const SmtpClient = require('../../services/smtp/SmtpClient');
    const client = new SmtpClient();

    const toList = Array.isArray(to) ? to : [to];
    const ccList = Array.isArray(cc) ? cc : (cc ? [cc] : []);
    const bccList = Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []);

    const info = await client.send({
      from: mb.full_name ? `"${mb.full_name}" <${fromEmail}>` : fromEmail,
      to: toList, cc: ccList.length ? ccList : undefined,
      bcc: bccList.length ? bccList : undefined,
      subject, html: bodyHtml, text: bodyText,
    }, mb.domain);

    // Save to Sent folder
    const sentFolder = await db.query(
      "SELECT id, uid_next FROM folders WHERE mailbox_id = $1 AND name = 'Sent'",
      [req.user.sub]
    );
    if (sentFolder.rows.length) {
      const sf = sentFolder.rows[0];
      await db.query(
        `INSERT INTO messages (mailbox_id, folder_id, uid, subject, from_address, to_addresses,
          cc_addresses, body_html, body_text, is_seen, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,NOW())`,
        [req.user.sub, sf.id, sf.uid_next, subject, fromEmail,
         JSON.stringify(toList), JSON.stringify(ccList), bodyHtml || '', bodyText || '']
      );
      await db.query('UPDATE folders SET uid_next = uid_next + 1, total_msgs = total_msgs + 1 WHERE id = $1', [sf.id]);
    }

    res.json({ message: 'Message sent', messageId: info?.messageId });
  } catch (err) {
    logger.error('Send message error', { error: err.message });
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// PATCH /api/webmail/messages/:id — Update flags (mark read/unread/flagged/move)
router.patch('/messages/:id', webmailAuth, async (req, res) => {
  try {
    const { is_seen, is_flagged, is_deleted, folder } = req.body;
    const msg = await db.query(
      'SELECT id, folder_id, is_seen FROM messages WHERE id = $1 AND mailbox_id = $2',
      [req.params.id, req.user.sub]
    );
    if (!msg.rows.length) return res.status(404).json({ error: 'Message not found' });

    const updates = [];
    const params = [req.params.id];

    if (is_seen !== undefined)    { updates.push(`is_seen = $${params.length + 1}`); params.push(is_seen); }
    if (is_flagged !== undefined) { updates.push(`is_flagged = $${params.length + 1}`); params.push(is_flagged); }
    if (is_deleted !== undefined) { updates.push(`is_deleted = $${params.length + 1}`); params.push(is_deleted); }

    if (folder) {
      const destFolder = await db.query(
        'SELECT id FROM folders WHERE mailbox_id = $1 AND name = $2',
        [req.user.sub, folder]
      );
      if (destFolder.rows.length) {
        updates.push(`folder_id = $${params.length + 1}`);
        params.push(destFolder.rows[0].id);
      }
    }

    if (updates.length) {
      await db.query(`UPDATE messages SET ${updates.join(', ')} WHERE id = $1`, params);
    }

    // Sync unread counts
    await db.query(
      `UPDATE folders SET unseen_msgs = (SELECT COUNT(*) FROM messages WHERE folder_id = folders.id AND NOT is_seen AND NOT is_deleted)
       WHERE id = $1`,
      [msg.rows[0].folder_id]
    );

    res.json({ message: 'Updated' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/webmail/messages/:id — Move to trash or hard-delete from trash
router.delete('/messages/:id', webmailAuth, async (req, res) => {
  try {
    const msg = await db.query(
      `SELECT m.id, m.folder_id, f.name AS folder_name
       FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.id = $1 AND m.mailbox_id = $2`,
      [req.params.id, req.user.sub]
    );
    if (!msg.rows.length) return res.status(404).json({ error: 'Message not found' });

    const m = msg.rows[0];

    if (m.folder_name === 'Trash') {
      await db.query('DELETE FROM messages WHERE id = $1', [req.params.id]);
      res.json({ message: 'Permanently deleted' });
    } else {
      const trashFolder = await db.query(
        "SELECT id FROM folders WHERE mailbox_id = $1 AND name = 'Trash'",
        [req.user.sub]
      );
      if (trashFolder.rows.length) {
        await db.query(
          'UPDATE messages SET folder_id = $1, is_deleted = FALSE WHERE id = $2',
          [trashFolder.rows[0].id, req.params.id]
        );
      } else {
        await db.query('UPDATE messages SET is_deleted = TRUE WHERE id = $1', [req.params.id]);
      }
      res.json({ message: 'Moved to trash' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
