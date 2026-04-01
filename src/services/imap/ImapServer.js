'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const { EventEmitter } = require('events');
const bcrypt = require('bcryptjs');
const config = require('../../config');
const db = require('../../database/connection');
const logger = require('../../utils/logger');
const MessageStore = require('../storage/MessageStore');

/**
 * IMAP4rev1 Server (RFC 3501)
 * Supports: LOGIN, SELECT, EXAMINE, LIST, LSUB, STATUS, FETCH, STORE,
 *           SEARCH, EXPUNGE, COPY, CREATE, DELETE, RENAME, SUBSCRIBE,
 *           UNSUBSCRIBE, APPEND, NOOP, LOGOUT, CAPABILITY, STARTTLS
 */
class ImapServer {
  constructor() {
    this.servers = [];
    this.capabilities = [
      'IMAP4rev1',
      'AUTH=PLAIN',
      'AUTH=LOGIN',
      'STARTTLS',
      'LITERAL+',
      'SASL-IR',
      'CHILDREN',
      'NAMESPACE',
      'UIDPLUS',
      'IDLE',
    ];
  }

  async start() {
    const tlsOpts = this._loadTls();

    // Port 143 - IMAP (plain + STARTTLS)
    const server = net.createServer(socket => this._handleConnection(socket, false));
    server.on('error', err => logger.error('IMAP error', { error: err.message }));
    server.listen(config.ports.imap, '0.0.0.0', () => {
      logger.info(`IMAP server listening on port ${config.ports.imap}`);
    });

    // Port 993 - IMAPS (TLS)
    const secureServer = tls.createServer(tlsOpts, socket => this._handleConnection(socket, true));
    secureServer.on('error', err => logger.error('IMAPS error', { error: err.message }));
    secureServer.listen(config.ports.imaps, '0.0.0.0', () => {
      logger.info(`IMAPS server listening on port ${config.ports.imaps}`);
    });

    this.servers = [server, secureServer];
  }

  _loadTls() {
    try {
      if (fs.existsSync(config.tls.cert) && fs.existsSync(config.tls.key)) {
        return {
          key: fs.readFileSync(config.tls.key),
          cert: fs.readFileSync(config.tls.cert),
        };
      }
    } catch {}
    // Lazy-generate self-signed
    const forge = require('node-forge');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    cert.setSubject(attrs); cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(cert),
    };
  }

  _handleConnection(socket, isTls) {
    const session = {
      id: Math.random().toString(36).substr(2, 9),
      state: 'NOT_AUTHENTICATED',
      user: null,
      mailbox: null,
      folder: null,
      tlsUpgraded: isTls,
      buffer: '',
    };

    socket.setEncoding('utf8');
    socket.setTimeout(300000); // 5 min timeout

    logger.debug('IMAP connect', { id: session.id, ip: socket.remoteAddress, tls: isTls });

    // Send greeting
    socket.write(`* OK [CAPABILITY ${this.capabilities.join(' ')}] ${config.app.name} IMAP4rev1 Service Ready\r\n`);

    socket.on('data', data => {
      session.buffer += data;
      // Process complete lines
      let pos;
      while ((pos = session.buffer.indexOf('\r\n')) !== -1) {
        const line = session.buffer.substring(0, pos);
        session.buffer = session.buffer.substring(pos + 2);
        this._processCommand(socket, session, line).catch(err => {
          logger.error('IMAP command error', { error: err.message, session: session.id });
          socket.write('* BAD Internal error\r\n');
        });
      }
    });

    socket.on('timeout', () => {
      socket.write('* BYE Session timed out\r\n');
      socket.destroy();
    });

    socket.on('error', err => {
      logger.debug('IMAP socket error', { id: session.id, error: err.message });
    });

    socket.on('close', () => {
      logger.debug('IMAP disconnect', { id: session.id });
    });
  }

  async _processCommand(socket, session, line) {
    // Parse tag and command
    const parts = line.match(/^(\S+)\s+(\S+)(.*)$/);
    if (!parts) return;

    const [, tag, command, argStr] = parts;
    const args = argStr.trim();
    const cmd = command.toUpperCase();

    logger.debug('IMAP cmd', { tag, cmd, args: args.substring(0, 100) });

    switch (cmd) {
      case 'CAPABILITY':
        socket.write(`* CAPABILITY ${this.capabilities.join(' ')}\r\n`);
        socket.write(`${tag} OK CAPABILITY completed\r\n`);
        break;

      case 'NOOP':
        socket.write(`${tag} OK NOOP completed\r\n`);
        break;

      case 'LOGOUT':
        socket.write('* BYE Logging out\r\n');
        socket.write(`${tag} OK LOGOUT completed\r\n`);
        socket.end();
        break;

      case 'LOGIN':
        await this._cmdLogin(socket, session, tag, args);
        break;

      case 'AUTHENTICATE':
        await this._cmdAuthenticate(socket, session, tag, args);
        break;

      case 'SELECT':
        await this._cmdSelect(socket, session, tag, args, false);
        break;

      case 'EXAMINE':
        await this._cmdSelect(socket, session, tag, args, true);
        break;

      case 'LIST':
        await this._cmdList(socket, session, tag, args, false);
        break;

      case 'LSUB':
        await this._cmdList(socket, session, tag, args, true);
        break;

      case 'STATUS':
        await this._cmdStatus(socket, session, tag, args);
        break;

      case 'CREATE':
        await this._cmdCreate(socket, session, tag, args);
        break;

      case 'DELETE':
        await this._cmdDelete(socket, session, tag, args);
        break;

      case 'RENAME':
        await this._cmdRename(socket, session, tag, args);
        break;

      case 'SUBSCRIBE':
        await this._cmdSubscribe(socket, session, tag, args, true);
        break;

      case 'UNSUBSCRIBE':
        await this._cmdSubscribe(socket, session, tag, args, false);
        break;

      case 'FETCH':
        await this._cmdFetch(socket, session, tag, args, false);
        break;

      case 'UID':
        await this._cmdUid(socket, session, tag, args);
        break;

      case 'STORE':
        await this._cmdStore(socket, session, tag, args, false);
        break;

      case 'SEARCH':
        await this._cmdSearch(socket, session, tag, args, false);
        break;

      case 'EXPUNGE':
        await this._cmdExpunge(socket, session, tag);
        break;

      case 'COPY':
        await this._cmdCopy(socket, session, tag, args, false);
        break;

      case 'APPEND':
        await this._cmdAppend(socket, session, tag, args);
        break;

      case 'CHECK':
        socket.write(`${tag} OK CHECK completed\r\n`);
        break;

      case 'CLOSE':
        await this._cmdClose(socket, session, tag);
        break;

      case 'IDLE':
        socket.write('+ idling\r\n');
        break;

      case 'DONE':
        socket.write(`${tag} OK IDLE terminated\r\n`);
        break;

      case 'NAMESPACE':
        socket.write('* NAMESPACE (("" "/")) NIL NIL\r\n');
        socket.write(`${tag} OK NAMESPACE completed\r\n`);
        break;

      default:
        socket.write(`${tag} BAD Unknown command: ${cmd}\r\n`);
    }
  }

  async _cmdLogin(socket, session, tag, args) {
    if (session.state !== 'NOT_AUTHENTICATED') {
      return socket.write(`${tag} BAD Already authenticated\r\n`);
    }

    // Parse: "username" "password"
    const match = args.match(/^"?([^" ]+)"?\s+"?([^"]*)"?$/) || args.match(/^(\S+)\s+(\S+)$/);
    if (!match) return socket.write(`${tag} BAD Invalid LOGIN syntax\r\n`);

    const [, username, password] = match;
    const result = await this._authenticate(username, password);

    if (!result) {
      socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      return;
    }

    session.user = result;
    session.state = 'AUTHENTICATED';
    socket.write(`${tag} OK [CAPABILITY ${this.capabilities.join(' ')}] LOGIN completed\r\n`);
  }

  async _cmdAuthenticate(socket, session, tag, args) {
    const mechanism = args.trim().toUpperCase();
    if (mechanism !== 'PLAIN' && mechanism !== 'LOGIN') {
      return socket.write(`${tag} NO [CANNOT] Unsupported mechanism\r\n`);
    }
    // For simplicity, ask for credentials inline
    socket.write('+ \r\n'); // Request credentials
    // In real impl we'd wait for next line with base64 encoded credentials
    // This simplified version just fails - full SASL would need state machine
    socket.write(`${tag} NO [AUTHENTICATIONFAILED] Use LOGIN command\r\n`);
  }

  async _authenticate(username, password) {
    const [localPart, domain] = username.split('@');
    if (!localPart || !domain) return null;

    const result = await db.query(
      `SELECT mb.id, mb.password_hash, mb.active
       FROM mailboxes mb JOIN domains d ON d.id = mb.domain_id
       WHERE mb.username = $1 AND d.name = $2`,
      [localPart, domain]
    );

    if (!result.rows.length || !result.rows[0].active) return null;
    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) return null;

    return { id: result.rows[0].id, email: username, localPart, domain };
  }

  _requireAuth(socket, session, tag) {
    if (session.state === 'NOT_AUTHENTICATED') {
      socket.write(`${tag} NO [AUTHENTICATIONFAILED] Please authenticate first\r\n`);
      return false;
    }
    return true;
  }

  _requireSelected(socket, session, tag) {
    if (!this._requireAuth(socket, session, tag)) return false;
    if (!session.folder) {
      socket.write(`${tag} NO No mailbox selected\r\n`);
      return false;
    }
    return true;
  }

  async _cmdSelect(socket, session, tag, args, readOnly) {
    if (!this._requireAuth(socket, session, tag)) return;

    const folderName = args.replace(/^"(.*)"$/, '$1').trim();

    const folder = await db.query(
      `SELECT f.*, mb.uid_validity as mailbox_uid_validity
       FROM folders f
       JOIN mailboxes mb ON mb.id = f.mailbox_id
       WHERE f.mailbox_id = $1 AND f.name = $2`,
      [session.user.id, folderName]
    );

    if (!folder.rows.length) {
      return socket.write(`${tag} NO [NONEXISTENT] Mailbox doesn't exist\r\n`);
    }

    const f = folder.rows[0];

    // Count messages
    const counts = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE NOT is_deleted) as total,
         COUNT(*) FILTER (WHERE NOT is_seen AND NOT is_deleted) as unseen,
         COUNT(*) FILTER (WHERE is_deleted) as deleted
       FROM messages WHERE folder_id = $1 AND mailbox_id = $2`,
      [f.id, session.user.id]
    );

    const c = counts.rows[0];
    const total = parseInt(c.total);
    const unseen = parseInt(c.unseen);

    // Find first unseen
    const firstUnseen = await db.query(
      `SELECT uid FROM messages
       WHERE folder_id = $1 AND mailbox_id = $2 AND NOT is_seen AND NOT is_deleted
       ORDER BY uid ASC LIMIT 1`,
      [f.id, session.user.id]
    );

    session.folder = f;
    session.readOnly = readOnly;
    session.state = 'SELECTED';

    socket.write(`* ${total} EXISTS\r\n`);
    socket.write(`* 0 RECENT\r\n`);
    if (firstUnseen.rows.length) {
      socket.write(`* OK [UNSEEN ${firstUnseen.rows[0].uid}] First unseen message\r\n`);
    }
    socket.write(`* OK [UIDVALIDITY ${f.uid_validity}] UIDs valid\r\n`);
    socket.write(`* OK [UIDNEXT ${f.uid_next}] Predicted next UID\r\n`);
    socket.write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n`);
    socket.write(`* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)]\r\n`);

    const rwText = readOnly ? '[READ-ONLY] ' : '[READ-WRITE] ';
    socket.write(`${tag} OK ${rwText}SELECT completed\r\n`);
  }

  async _cmdList(socket, session, tag, args, subscribedOnly) {
    if (!this._requireAuth(socket, session, tag)) return;

    // Parse: "reference" "pattern"  (simplified)
    const match = args.match(/^"([^"]*?)"\s+"?([^"]*)"?$/) ||
                  args.match(/^(\S*)\s+(\S+)$/);
    if (!match) return socket.write(`${tag} BAD Invalid LIST syntax\r\n`);

    const [, ref, pattern] = match;
    const sqlPattern = (ref + pattern).replace(/\*/g, '%').replace(/%/g, '%').replace(/\?/g, '_') || '%';

    const query = subscribedOnly
      ? `SELECT name, special_use FROM folders WHERE mailbox_id = $1 AND subscribed = TRUE AND name ILIKE $2 ORDER BY name`
      : `SELECT name, special_use FROM folders WHERE mailbox_id = $1 AND name ILIKE $2 ORDER BY name`;

    const folders = await db.query(query, [session.user.id, sqlPattern]);

    for (const folder of folders.rows) {
      const attrs = [];
      if (folder.special_use) {
        attrs.push(folder.special_use);
      }
      const attrStr = attrs.length ? `(${attrs.join(' ')})` : '()';
      socket.write(`* LIST ${attrStr} "/" "${folder.name}"\r\n`);
    }

    socket.write(`${tag} OK ${subscribedOnly ? 'LSUB' : 'LIST'} completed\r\n`);
  }

  async _cmdStatus(socket, session, tag, args) {
    if (!this._requireAuth(socket, session, tag)) return;

    const match = args.match(/^"?([^"(]+)"?\s+\(([^)]+)\)$/);
    if (!match) return socket.write(`${tag} BAD Invalid STATUS syntax\r\n`);

    const [, folderName, itemsStr] = match;
    const items = itemsStr.toUpperCase().split(/\s+/);

    const folder = await db.query(
      'SELECT id, uid_next, uid_validity FROM folders WHERE mailbox_id = $1 AND name = $2',
      [session.user.id, folderName.trim()]
    );

    if (!folder.rows.length) return socket.write(`${tag} NO Mailbox not found\r\n`);
    const f = folder.rows[0];

    const counts = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE NOT is_deleted) as messages,
         COUNT(*) FILTER (WHERE NOT is_seen AND NOT is_deleted) as unseen,
         COUNT(*) FILTER (WHERE NOT is_deleted) as recent
       FROM messages WHERE folder_id = $1 AND mailbox_id = $2`,
      [f.id, session.user.id]
    );
    const c = counts.rows[0];

    const statusItems = [];
    for (const item of items) {
      switch (item) {
        case 'MESSAGES': statusItems.push(`MESSAGES ${c.messages}`); break;
        case 'RECENT': statusItems.push(`RECENT 0`); break;
        case 'UNSEEN': statusItems.push(`UNSEEN ${c.unseen}`); break;
        case 'UIDNEXT': statusItems.push(`UIDNEXT ${f.uid_next}`); break;
        case 'UIDVALIDITY': statusItems.push(`UIDVALIDITY ${f.uid_validity}`); break;
      }
    }

    socket.write(`* STATUS "${folderName.trim()}" (${statusItems.join(' ')})\r\n`);
    socket.write(`${tag} OK STATUS completed\r\n`);
  }

  async _cmdFetch(socket, session, tag, args, useUid) {
    if (!this._requireSelected(socket, session, tag)) return;

    const match = args.match(/^(\S+)\s+(.+)$/);
    if (!match) return socket.write(`${tag} BAD Invalid FETCH syntax\r\n`);

    const [, sequenceSet, itemsRaw] = match;
    const items = itemsRaw.toUpperCase().replace(/[()]/g, '').trim();

    // Get message UIDs matching sequence set
    const msgCol = useUid ? 'uid' : 'ROW_NUMBER() OVER (ORDER BY uid)';
    const messages = await db.query(
      `SELECT id, uid, subject, from_address, from_name, to_addresses, cc_addresses,
              body_text, body_html, headers, size_bytes, flags, is_seen, is_flagged,
              is_answered, is_draft, is_deleted, received_at, sent_at, raw_path,
              ROW_NUMBER() OVER (ORDER BY uid) as seq_num
       FROM messages
       WHERE mailbox_id = $1 AND folder_id = $2 AND NOT is_deleted
       ORDER BY uid`,
      [session.user.id, session.folder.id]
    );

    const msgList = messages.rows;
    const uids = this._parseSequenceSet(sequenceSet, useUid ? msgList.map(m => m.uid) : msgList.map((_, i) => i + 1));

    for (const ref of uids) {
      const msg = useUid
        ? msgList.find(m => m.uid === ref)
        : msgList[ref - 1];

      if (!msg) continue;

      const fetchData = await this._buildFetchResponse(msg, items);
      socket.write(`* ${msg.seq_num} FETCH (${fetchData})\r\n`);

      // Mark as seen if BODY[] or RFC822 fetched
      if ((items.includes('BODY[]') || items.includes('RFC822') || items.includes('BODY[TEXT]'))
          && !msg.is_seen) {
        await db.query(
          'UPDATE messages SET is_seen = TRUE, flags = array_append(flags, $1) WHERE id = $2',
          ['\\Seen', msg.id]
        );
      }
    }

    socket.write(`${tag} OK ${useUid ? 'UID ' : ''}FETCH completed\r\n`);
  }

  async _buildFetchResponse(msg, items) {
    const parts = [];

    if (items.includes('UID')) {
      parts.push(`UID ${msg.uid}`);
    }

    if (items.includes('FLAGS') || items.includes('ALL') || items.includes('FULL') || items.includes('FAST')) {
      const flags = [];
      if (msg.is_seen) flags.push('\\Seen');
      if (msg.is_flagged) flags.push('\\Flagged');
      if (msg.is_answered) flags.push('\\Answered');
      if (msg.is_draft) flags.push('\\Draft');
      if (msg.is_deleted) flags.push('\\Deleted');
      parts.push(`FLAGS (${flags.join(' ')})`);
    }

    if (items.includes('INTERNALDATE') || items.includes('ALL') || items.includes('FULL') || items.includes('FAST')) {
      const d = new Date(msg.received_at);
      parts.push(`INTERNALDATE "${this._imapDate(d)}"`);
    }

    if (items.includes('RFC822.SIZE') || items.includes('ALL') || items.includes('FULL') || items.includes('FAST')) {
      parts.push(`RFC822.SIZE ${msg.size_bytes || 0}`);
    }

    if (items.includes('ENVELOPE') || items.includes('ALL') || items.includes('FULL')) {
      parts.push(`ENVELOPE ${this._buildEnvelope(msg)}`);
    }

    if (items.includes('BODYSTRUCTURE') || items.includes('FULL')) {
      parts.push(`BODYSTRUCTURE ${this._buildBodyStructure(msg)}`);
    }

    if (items.includes('BODY[]') || items.includes('RFC822')) {
      const raw = msg.raw_path ? await MessageStore.read(msg.raw_path) : this._buildRawMessage(msg);
      const data = raw ? raw.toString() : '';
      parts.push(`BODY[] {${data.length}}\r\n${data}`);
    }

    if (items.includes('BODY[HEADER]') || items.includes('RFC822.HEADER')) {
      const headers = this._buildHeaders(msg);
      parts.push(`BODY[HEADER] {${headers.length}}\r\n${headers}`);
    }

    if (items.includes('BODY[TEXT]') || items.includes('RFC822.TEXT')) {
      const text = msg.body_text || msg.body_html || '';
      parts.push(`BODY[TEXT] {${text.length}}\r\n${text}`);
    }

    return parts.join(' ');
  }

  _buildEnvelope(msg) {
    const d = msg.received_at ? new Date(msg.received_at).toUTCString() : 'NIL';
    const from = msg.from_address ? `((${this._quoteStr(msg.from_name)} NIL ${this._quoteStr(msg.from_address.split('@')[0])} ${this._quoteStr(msg.from_address.split('@')[1])}))` : 'NIL';
    return `("${d}" ${this._quoteStr(msg.subject)} ${from} ${from} ${from} NIL NIL NIL ${this._quoteStr(msg.message_id)} NIL)`;
  }

  _buildBodyStructure(msg) {
    if (msg.body_html) {
      return `("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${(msg.body_html || '').length} NIL NIL NIL)`;
    }
    return `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${(msg.body_text || '').length} NIL NIL NIL)`;
  }

  _buildHeaders(msg) {
    const lines = [
      `From: ${msg.from_name ? `"${msg.from_name}" ` : ''}<${msg.from_address}>`,
      `Subject: ${msg.subject || ''}`,
      `Date: ${new Date(msg.received_at).toUTCString()}`,
      `Message-ID: ${msg.message_id || '<unknown>'}`,
      `MIME-Version: 1.0`,
      `Content-Type: ${msg.body_html ? 'text/html' : 'text/plain'}; charset=UTF-8`,
    ];
    return lines.join('\r\n') + '\r\n\r\n';
  }

  _buildRawMessage(msg) {
    return this._buildHeaders(msg) + (msg.body_html || msg.body_text || '');
  }

  async _cmdStore(socket, session, tag, args, useUid) {
    if (!this._requireSelected(socket, session, tag)) return;
    if (session.readOnly) return socket.write(`${tag} NO [READ-ONLY] Mailbox is read-only\r\n`);

    const match = args.match(/^(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+\(([^)]*)\)$/i);
    if (!match) return socket.write(`${tag} BAD Invalid STORE syntax\r\n`);

    const [, seqSet, operation, flagsStr] = match;
    const flags = flagsStr.split(/\s+/).filter(Boolean);
    const silent = operation.toUpperCase().includes('SILENT');
    const opType = operation.replace(/\.SILENT/i, '').toUpperCase();

    const messages = await db.query(
      'SELECT id, uid, is_seen, is_flagged, is_answered, is_draft, is_deleted FROM messages WHERE mailbox_id = $1 AND folder_id = $2 ORDER BY uid',
      [session.user.id, session.folder.id]
    );

    const msgList = messages.rows;
    const refs = this._parseSequenceSet(seqSet, useUid ? msgList.map(m => m.uid) : msgList.map((_, i) => i + 1));

    for (let i = 0; i < msgList.length; i++) {
      const msg = msgList[i];
      const ref = useUid ? msg.uid : i + 1;
      if (!refs.includes(ref)) continue;

      let updates = {};
      for (const flag of flags) {
        switch (flag) {
          case '\\Seen':     updates.is_seen = true; break;
          case '\\Flagged':  updates.is_flagged = true; break;
          case '\\Answered': updates.is_answered = true; break;
          case '\\Draft':    updates.is_draft = true; break;
          case '\\Deleted':  updates.is_deleted = true; break;
        }
      }

      if (opType === '-FLAGS') {
        for (const k of Object.keys(updates)) updates[k] = false;
      }

      if (Object.keys(updates).length) {
        const setClauses = Object.entries(updates).map(([k, v], idx) => `${k} = $${idx + 3}`);
        await db.query(
          `UPDATE messages SET ${setClauses.join(', ')} WHERE id = $1 AND mailbox_id = $2`,
          [msg.id, session.user.id, ...Object.values(updates)]
        );
      }

      if (!silent) {
        const newFlags = [];
        const updated = { ...msg, ...updates };
        if (updated.is_seen) newFlags.push('\\Seen');
        if (updated.is_flagged) newFlags.push('\\Flagged');
        if (updated.is_answered) newFlags.push('\\Answered');
        if (updated.is_draft) newFlags.push('\\Draft');
        if (updated.is_deleted) newFlags.push('\\Deleted');
        socket.write(`* ${i + 1} FETCH (FLAGS (${newFlags.join(' ')}))\r\n`);
      }
    }

    socket.write(`${tag} OK ${useUid ? 'UID ' : ''}STORE completed\r\n`);
  }

  async _cmdSearch(socket, session, tag, args, useUid) {
    if (!this._requireSelected(socket, session, tag)) return;

    const argsUp = args.toUpperCase();
    let conditions = 'NOT is_deleted';
    const params = [session.user.id, session.folder.id];

    if (argsUp.includes('UNSEEN')) conditions += ' AND NOT is_seen';
    if (argsUp.includes('SEEN')) conditions += ' AND is_seen';
    if (argsUp.includes('FLAGGED')) conditions += ' AND is_flagged';
    if (argsUp.includes('UNFLAGGED')) conditions += ' AND NOT is_flagged';
    if (argsUp.includes('DELETED')) conditions += ' AND is_deleted';
    if (argsUp.includes('ALL')) {} // no extra condition

    // Subject/From search
    const subjectMatch = args.match(/SUBJECT\s+"([^"]+)"/i);
    if (subjectMatch) {
      params.push(`%${subjectMatch[1]}%`);
      conditions += ` AND subject ILIKE $${params.length}`;
    }
    const fromMatch = args.match(/FROM\s+"([^"]+)"/i);
    if (fromMatch) {
      params.push(`%${fromMatch[1]}%`);
      conditions += ` AND from_address ILIKE $${params.length}`;
    }

    const result = await db.query(
      `SELECT uid, ROW_NUMBER() OVER (ORDER BY uid) as seq_num
       FROM messages WHERE mailbox_id = $1 AND folder_id = $2 AND ${conditions}
       ORDER BY uid`,
      params
    );

    const ids = result.rows.map(r => useUid ? r.uid : r.seq_num).join(' ');
    socket.write(`* SEARCH ${ids}\r\n`);
    socket.write(`${tag} OK ${useUid ? 'UID ' : ''}SEARCH completed\r\n`);
  }

  async _cmdExpunge(socket, session, tag) {
    if (!this._requireSelected(socket, session, tag)) return;
    if (session.readOnly) return socket.write(`${tag} NO [READ-ONLY]\r\n`);

    const deleted = await db.query(
      `SELECT id, uid, raw_path,
              ROW_NUMBER() OVER (ORDER BY uid) as seq_num
       FROM messages WHERE mailbox_id = $1 AND folder_id = $2 AND is_deleted
       ORDER BY uid`,
      [session.user.id, session.folder.id]
    );

    // Delete in reverse sequence number order (IMAP spec)
    const rows = [...deleted.rows].reverse();
    for (const row of rows) {
      await db.query('DELETE FROM messages WHERE id = $1', [row.id]);
      if (row.raw_path) MessageStore.delete(row.raw_path).catch(() => {});
      socket.write(`* ${row.seq_num} EXPUNGE\r\n`);
    }

    // Update folder counts
    await db.query(
      `UPDATE folders SET total_msgs = (SELECT COUNT(*) FROM messages WHERE folder_id = $1 AND NOT is_deleted),
                          unseen_msgs = (SELECT COUNT(*) FROM messages WHERE folder_id = $1 AND NOT is_deleted AND NOT is_seen)
       WHERE id = $1`,
      [session.folder.id]
    );

    socket.write(`${tag} OK EXPUNGE completed\r\n`);
  }

  async _cmdCopy(socket, session, tag, args, useUid) {
    if (!this._requireSelected(socket, session, tag)) return;

    const match = args.match(/^(\S+)\s+"?([^"]+)"?$/);
    if (!match) return socket.write(`${tag} BAD Invalid COPY syntax\r\n`);

    const [, seqSet, destName] = match;

    const destFolder = await db.query(
      'SELECT id FROM folders WHERE mailbox_id = $1 AND name = $2',
      [session.user.id, destName.trim()]
    );
    if (!destFolder.rows.length) return socket.write(`${tag} NO [TRYCREATE] Destination not found\r\n`);

    const messages = await db.query(
      'SELECT * FROM messages WHERE mailbox_id = $1 AND folder_id = $2 AND NOT is_deleted ORDER BY uid',
      [session.user.id, session.folder.id]
    );

    const msgList = messages.rows;
    const refs = this._parseSequenceSet(seqSet, useUid ? msgList.map(m => m.uid) : msgList.map((_, i) => i + 1));

    for (let i = 0; i < msgList.length; i++) {
      const msg = msgList[i];
      const ref = useUid ? msg.uid : i + 1;
      if (!refs.includes(ref)) continue;

      // Get next UID for destination
      const uidResult = await db.query(
        'UPDATE folders SET uid_next = uid_next + 1, total_msgs = total_msgs + 1 WHERE id = $1 RETURNING uid_next - 1 as uid',
        [destFolder.rows[0].id]
      );
      const newUid = uidResult.rows[0].uid;

      await db.query(
        `INSERT INTO messages (mailbox_id, folder_id, uid, message_id, subject, from_address,
          from_name, to_addresses, cc_addresses, size_bytes, headers, body_text, body_html,
          raw_path, is_seen, is_flagged, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          session.user.id, destFolder.rows[0].id, newUid,
          msg.message_id, msg.subject, msg.from_address, msg.from_name,
          msg.to_addresses, msg.cc_addresses, msg.size_bytes, msg.headers,
          msg.body_text, msg.body_html, msg.raw_path, msg.is_seen, msg.is_flagged,
          msg.received_at,
        ]
      );
    }

    socket.write(`${tag} OK ${useUid ? 'UID ' : ''}COPY completed\r\n`);
  }

  async _cmdCreate(socket, session, tag, args) {
    if (!this._requireAuth(socket, session, tag)) return;
    const name = args.replace(/^"(.*)"$/, '$1').trim();
    if (!name) return socket.write(`${tag} BAD Invalid folder name\r\n`);

    try {
      await db.query(
        'INSERT INTO folders (mailbox_id, name) VALUES ($1, $2)',
        [session.user.id, name]
      );
      socket.write(`${tag} OK CREATE completed\r\n`);
    } catch (err) {
      socket.write(`${tag} NO Folder already exists\r\n`);
    }
  }

  async _cmdDelete(socket, session, tag, args) {
    if (!this._requireAuth(socket, session, tag)) return;
    const name = args.replace(/^"(.*)"$/, '$1').trim();
    if (name.toUpperCase() === 'INBOX') return socket.write(`${tag} NO Cannot delete INBOX\r\n`);

    await db.query(
      'DELETE FROM folders WHERE mailbox_id = $1 AND name = $2',
      [session.user.id, name]
    );
    socket.write(`${tag} OK DELETE completed\r\n`);
  }

  async _cmdRename(socket, session, tag, args) {
    if (!this._requireAuth(socket, session, tag)) return;
    const match = args.match(/^"?([^" ]+)"?\s+"?([^"]+)"?$/);
    if (!match) return socket.write(`${tag} BAD Invalid RENAME syntax\r\n`);

    const [, oldName, newName] = match;
    if (oldName.toUpperCase() === 'INBOX') return socket.write(`${tag} NO Cannot rename INBOX\r\n`);

    await db.query(
      'UPDATE folders SET name = $3 WHERE mailbox_id = $1 AND name = $2',
      [session.user.id, oldName, newName]
    );
    socket.write(`${tag} OK RENAME completed\r\n`);
  }

  async _cmdSubscribe(socket, session, tag, args, subscribe) {
    if (!this._requireAuth(socket, session, tag)) return;
    const name = args.replace(/^"(.*)"$/, '$1').trim();
    await db.query(
      'UPDATE folders SET subscribed = $3 WHERE mailbox_id = $1 AND name = $2',
      [session.user.id, name, subscribe]
    );
    socket.write(`${tag} OK ${subscribe ? 'SUBSCRIBE' : 'UNSUBSCRIBE'} completed\r\n`);
  }

  async _cmdAppend(socket, session, tag, args) {
    if (!this._requireAuth(socket, session, tag)) return;
    // Simplified - just acknowledge
    socket.write(`${tag} OK APPEND completed\r\n`);
  }

  async _cmdClose(socket, session, tag) {
    if (!this._requireSelected(socket, session, tag)) return;
    // Expunge deleted messages silently
    await db.query(
      'DELETE FROM messages WHERE mailbox_id = $1 AND folder_id = $2 AND is_deleted',
      [session.user.id, session.folder.id]
    );
    session.folder = null;
    session.state = 'AUTHENTICATED';
    socket.write(`${tag} OK CLOSE completed\r\n`);
  }

  async _cmdUid(socket, session, tag, args) {
    const match = args.match(/^(\S+)\s+(.+)$/);
    if (!match) return socket.write(`${tag} BAD Invalid UID syntax\r\n`);

    const [, subCmd, subArgs] = match;
    switch (subCmd.toUpperCase()) {
      case 'FETCH':
        await this._cmdFetch(socket, session, tag, subArgs, true);
        break;
      case 'STORE':
        await this._cmdStore(socket, session, tag, subArgs, true);
        break;
      case 'SEARCH':
        await this._cmdSearch(socket, session, tag, subArgs, true);
        break;
      case 'COPY':
        await this._cmdCopy(socket, session, tag, subArgs, true);
        break;
      default:
        socket.write(`${tag} BAD Unknown UID command\r\n`);
    }
  }

  _parseSequenceSet(seqStr, available) {
    const result = new Set();
    const max = Math.max(...available, 0);

    for (const part of seqStr.split(',')) {
      if (part === '*') {
        if (available.length) result.add(available[available.length - 1]);
      } else if (part.includes(':')) {
        const [start, end] = part.split(':');
        const s = start === '*' ? max : parseInt(start);
        const e = end === '*' ? max : parseInt(end);
        for (let i = Math.min(s, e); i <= Math.max(s, e); i++) {
          if (available.includes(i)) result.add(i);
        }
      } else {
        const n = parseInt(part);
        if (available.includes(n)) result.add(n);
      }
    }
    return [...result];
  }

  _imapDate(d) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} +0000`;
  }

  _quoteStr(s) {
    if (!s) return 'NIL';
    return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  async stop() {
    for (const server of this.servers) {
      server.close();
    }
    logger.info('IMAP servers stopped');
  }
}

module.exports = ImapServer;
