'use strict';

const express = require('express');
const db = require('../../database/connection');
const logger = require('../../utils/logger');
const { authenticate } = require('../middleware/authenticate');
const smtpClient = require('../../services/smtp/SmtpClient');
const MessageStore = require('../../services/storage/MessageStore');

const router = express.Router();
router.use(authenticate);

// GET /api/messages/folders - list folders
router.get('/folders', async (req, res) => {
  try {
    const folders = await db.query(
      `SELECT f.id, f.name, f.special_use, f.subscribed,
              f.total_msgs, f.unseen_msgs, f.uid_next
       FROM folders f
       WHERE f.mailbox_id = $1
       ORDER BY CASE f.name WHEN 'INBOX' THEN 0 WHEN 'Sent' THEN 1 WHEN 'Drafts' THEN 2 WHEN 'Trash' THEN 3 WHEN 'Spam' THEN 4 ELSE 5 END, f.name`,
      [req.user.id]
    );
    res.json(folders.rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/messages/folders - create folder
router.post('/folders', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name required' });
    const result = await db.query(
      'INSERT INTO folders (mailbox_id, name) VALUES ($1, $2) RETURNING *',
      [req.user.id, name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Folder already exists' });
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/messages/folders/:fid
router.delete('/folders/:fid', async (req, res) => {
  try {
    const folder = await db.query(
      'SELECT name FROM folders WHERE id = $1 AND mailbox_id = $2',
      [req.params.fid, req.user.id]
    );
    if (!folder.rows.length) return res.status(404).json({ error: 'Folder not found' });
    if (['INBOX','Sent','Drafts','Trash','Spam'].includes(folder.rows[0].name)) {
      return res.status(400).json({ error: 'Cannot delete system folder' });
    }
    await db.query('DELETE FROM folders WHERE id = $1 AND mailbox_id = $2', [req.params.fid, req.user.id]);
    res.json({ message: 'Folder deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/messages - list messages in a folder
router.get('/', async (req, res) => {
  try {
    const { folder = 'INBOX', page = 1, limit = 50, search, flags } = req.query;
    const offset = (page - 1) * limit;

    const folderResult = await db.query(
      'SELECT id FROM folders WHERE mailbox_id = $1 AND name = $2',
      [req.user.id, folder]
    );
    if (!folderResult.rows.length) return res.status(404).json({ error: 'Folder not found' });

    const params = [req.user.id, folderResult.rows[0].id, parseInt(limit), offset];
    const conditions = ['m.mailbox_id = $1', 'm.folder_id = $2', 'NOT m.is_deleted'];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(m.subject ILIKE $${params.length} OR m.from_address ILIKE $${params.length} OR m.body_text ILIKE $${params.length})`);
    }
    if (flags === 'unread') conditions.push('NOT m.is_seen');
    if (flags === 'flagged') conditions.push('m.is_flagged');

    const whereStr = conditions.join(' AND ');

    const [msgs, count] = await Promise.all([
      db.query(
        `SELECT m.id, m.uid, m.subject, m.from_address, m.from_name, m.to_addresses,
                m.size_bytes, m.is_seen, m.is_flagged, m.is_answered, m.is_draft,
                m.has_attachments, m.received_at, m.spf_result, m.dkim_result
         FROM messages m WHERE ${whereStr}
         ORDER BY m.received_at DESC LIMIT $3 OFFSET $4`,
        params
      ),
      db.query(`SELECT COUNT(*) FROM messages m WHERE ${whereStr}`, params.slice(0, 2)),
    ]);

    res.json({
      messages: msgs.rows,
      total: parseInt(count.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    logger.error('List messages error', { error: err.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/messages/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT m.*, f.name as folder_name
       FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.id = $1 AND m.mailbox_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });

    if (!result.rows[0].is_seen) {
      await db.query('UPDATE messages SET is_seen = TRUE WHERE id = $1', [req.params.id]);
      await db.query(
        'UPDATE folders SET unseen_msgs = GREATEST(0, unseen_msgs - 1) WHERE id = $1',
        [result.rows[0].folder_id]
      );
    }

    const attachments = await db.query(
      'SELECT id, filename, content_type, size_bytes, inline FROM attachments WHERE message_id = $1',
      [req.params.id]
    );

    res.json({ ...result.rows[0], attachments: attachments.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/messages - send or save draft
router.post('/', async (req, res) => {
  try {
    const { to, cc, bcc, subject, bodyHtml, bodyText, replyToId, isDraft } = req.body;

    if (!isDraft && (!to || !subject)) {
      return res.status(400).json({ error: 'To and subject required' });
    }

    const mailbox = await db.query(
      `SELECT mb.*, d.name as domain FROM mailboxes mb
       JOIN domains d ON d.id = mb.domain_id WHERE mb.id = $1`,
      [req.user.id]
    );
    if (!mailbox.rows.length) return res.status(403).json({ error: 'Mailbox not found' });

    const mb = mailbox.rows[0];
    const fromEmail = `${mb.username}@${mb.domain}`;

    if (isDraft) {
      const draftFolder = await db.query(
        "SELECT id, uid_next FROM folders WHERE mailbox_id = $1 AND name = 'Drafts'",
        [req.user.id]
      );
      if (!draftFolder.rows.length) return res.status(404).json({ error: 'Drafts folder not found' });
      const uid = draftFolder.rows[0].uid_next;
      await db.query('UPDATE folders SET uid_next = uid_next + 1, total_msgs = total_msgs + 1 WHERE id = $1', [draftFolder.rows[0].id]);
      const result = await db.query(
        `INSERT INTO messages (mailbox_id, folder_id, uid, subject, from_address, to_addresses,
          cc_addresses, body_html, body_text, is_draft, is_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,TRUE) RETURNING id`,
        [req.user.id, draftFolder.rows[0].id, uid, subject, fromEmail,
         JSON.stringify(Array.isArray(to) ? to : (to ? [to] : [])),
         JSON.stringify(Array.isArray(cc) ? cc : (cc ? [cc] : [])),
         bodyHtml || '', bodyText || '']
      );
      return res.status(201).json({ id: result.rows[0].id, message: 'Draft saved' });
    }

    if (!mb.can_send) return res.status(403).json({ error: 'Sending is disabled for this account' });

    const toList = Array.isArray(to) ? to : [to];
    const ccList = Array.isArray(cc) ? cc : (cc ? [cc] : []);
    const bccList = Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []);

    const msgOptions = {
      from: mb.full_name ? `"${mb.full_name}" <${fromEmail}>` : fromEmail,
      to: toList, cc: ccList.length ? ccList : undefined,
      bcc: bccList.length ? bccList : undefined,
      subject, html: bodyHtml || undefined, text: bodyText || undefined,
    };

    if (replyToId) {
      const orig = await db.query('SELECT message_id FROM messages WHERE id = $1', [replyToId]);
      if (orig.rows.length && orig.rows[0].message_id) {
        msgOptions.inReplyTo = orig.rows[0].message_id;
        msgOptions.references = orig.rows[0].message_id;
      }
    }

    const sendResult = await smtpClient.send(msgOptions, mb.domain);

    // Save to Sent
    const sentFolder = await db.query(
      "SELECT id, uid_next FROM folders WHERE mailbox_id = $1 AND name = 'Sent'", [req.user.id]
    );
    if (sentFolder.rows.length) {
      const uid = sentFolder.rows[0].uid_next;
      await db.query('UPDATE folders SET uid_next = uid_next + 1, total_msgs = total_msgs + 1 WHERE id = $1', [sentFolder.rows[0].id]);
      await db.query(
        `INSERT INTO messages (mailbox_id, folder_id, uid, message_id, subject, from_address,
          to_addresses, cc_addresses, body_html, body_text, is_seen, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,NOW())`,
        [req.user.id, sentFolder.rows[0].id, uid, sendResult.messageId || null,
         subject, fromEmail, JSON.stringify(toList), JSON.stringify(ccList),
         bodyHtml || '', bodyText || '']
      );
    }

    res.json({ message: 'Sent successfully', messageId: sendResult.messageId });
  } catch (err) {
    logger.error('Send message error', { error: err.message });
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// PATCH /api/messages/:id
router.patch('/:id', async (req, res) => {
  try {
    const { is_seen, is_flagged, is_answered, folder } = req.body;
    const updates = {};
    if (is_seen !== undefined) updates.is_seen = is_seen;
    if (is_flagged !== undefined) updates.is_flagged = is_flagged;
    if (is_answered !== undefined) updates.is_answered = is_answered;

    if (folder) {
      const fr = await db.query('SELECT id FROM folders WHERE mailbox_id = $1 AND name = $2', [req.user.id, folder]);
      if (fr.rows.length) updates.folder_id = fr.rows[0].id;
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 3}`);
    const result = await db.query(
      `UPDATE messages SET ${setClauses.join(', ')} WHERE id = $1 AND mailbox_id = $2 RETURNING id`,
      [req.params.id, req.user.id, ...Object.values(updates)]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json({ message: 'Updated' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/messages/:id
router.delete('/:id', async (req, res) => {
  try {
    const { permanent } = req.query;
    const msg = await db.query(
      `SELECT m.id, m.folder_id, f.name as folder_name, m.raw_path
       FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.id = $1 AND m.mailbox_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!msg.rows.length) return res.status(404).json({ error: 'Message not found' });

    if (permanent === 'true' || msg.rows[0].folder_name === 'Trash') {
      await db.query('DELETE FROM messages WHERE id = $1', [req.params.id]);
      if (msg.rows[0].raw_path) MessageStore.delete(msg.rows[0].raw_path).catch(() => {});
    } else {
      const trash = await db.query("SELECT id FROM folders WHERE mailbox_id = $1 AND name = 'Trash'", [req.user.id]);
      if (trash.rows.length) {
        await db.query('UPDATE messages SET folder_id = $1 WHERE id = $2', [trash.rows[0].id, req.params.id]);
      } else {
        await db.query('UPDATE messages SET is_deleted = TRUE WHERE id = $1', [req.params.id]);
      }
    }
    res.json({ message: 'Message deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/messages/bulk-action
router.post('/bulk-action', async (req, res) => {
  try {
    const { ids, action, folder } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'Message IDs required' });

    const ph = ids.map((_, i) => `$${i + 2}`).join(',');

    switch (action) {
      case 'mark-read':
        await db.query(`UPDATE messages SET is_seen = TRUE WHERE id IN (${ph}) AND mailbox_id = $1`, [req.user.id, ...ids]);
        break;
      case 'mark-unread':
        await db.query(`UPDATE messages SET is_seen = FALSE WHERE id IN (${ph}) AND mailbox_id = $1`, [req.user.id, ...ids]);
        break;
      case 'delete': {
        const trash = await db.query("SELECT id FROM folders WHERE mailbox_id = $1 AND name = 'Trash'", [req.user.id]);
        if (trash.rows.length) {
          await db.query(`UPDATE messages SET folder_id = $2 WHERE id IN (${ph}) AND mailbox_id = $1`, [req.user.id, trash.rows[0].id, ...ids]);
        }
        break;
      }
      case 'move': {
        if (!folder) return res.status(400).json({ error: 'Target folder required' });
        const fr = await db.query('SELECT id FROM folders WHERE mailbox_id = $1 AND name = $2', [req.user.id, folder]);
        if (!fr.rows.length) return res.status(404).json({ error: 'Target folder not found' });
        await db.query(`UPDATE messages SET folder_id = $2 WHERE id IN (${ph}) AND mailbox_id = $1`, [req.user.id, fr.rows[0].id, ...ids]);
        break;
      }
      default:
        return res.status(400).json({ error: 'Unknown action' });
    }

    res.json({ message: `${action} applied to ${ids.length} messages` });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
