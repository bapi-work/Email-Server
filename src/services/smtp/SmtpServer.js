'use strict';

const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const dns = require('dns').promises;
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const config = require('../../config');
const db = require('../../database/connection');
const logger = require('../../utils/logger');
const DkimService = require('../dkim/DkimService');
const MessageStore = require('../storage/MessageStore');

class SmtpInboundServer {
  constructor() {
    this.servers = [];
    this._authFailures = new Map();
  }

  /**
   * Start all SMTP listening ports (25, 587, 465)
   */
  async start() {
    const tlsOptions = this._loadTls();

    // Port 25 - MTA (receive mail from internet, no auth required)
    const mtaServer = this._createServer({
      port: config.ports.smtp,
      name: 'MTA (25)',
      secure: false,
      authRequired: false,
      tls: tlsOptions,
      isMta: true,
    });

    // Port 587 - Submission (authenticated clients)
    const submissionServer = this._createServer({
      port: config.ports.smtpSubmission,
      name: 'Submission (587)',
      secure: false,
      authRequired: true,
      tls: tlsOptions,
      isMta: false,
    });

    // Port 465 - SMTPS (TLS-first submission)
    const smtpsServer = this._createServer({
      port: config.ports.smtpSecure,
      name: 'SMTPS (465)',
      secure: true,
      authRequired: true,
      tls: tlsOptions,
      isMta: false,
    });

    this.servers = [mtaServer, submissionServer, smtpsServer];
    logger.info('SMTP servers started', {
      ports: [config.ports.smtp, config.ports.smtpSubmission, config.ports.smtpSecure],
    });
  }

  _loadTls() {
    try {
      if (fs.existsSync(config.tls.cert) && fs.existsSync(config.tls.key)) {
        return {
          key: fs.readFileSync(config.tls.key),
          cert: fs.readFileSync(config.tls.cert),
        };
      }
    } catch (err) {
      logger.warn('TLS certs not found, using self-signed', { error: err.message });
    }
    // Generate self-signed cert for dev
    return this._generateSelfSigned();
  }

  _generateSelfSigned() {
    const forge = require('node-forge');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(cert),
    };
  }

  _createServer({ port, name, secure, authRequired, tls, isMta }) {
    const serverOptions = {
      name: config.app.name,
      banner: `${config.app.name} ESMTP Service Ready`,
      size: config.limits.maxMessageSizeMb * 1024 * 1024,
      secure,
      key: tls.key,
      cert: tls.cert,
      authOptional: !authRequired,
      disabledCommands: authRequired ? [] : ['AUTH'],
      logger: false,

      onAuth: async (auth, session, callback) => {
        await this._handleAuth(auth, session, callback);
      },

      onConnect: async (session, callback) => {
        await this._handleConnect(session, callback, isMta);
      },

      onMailFrom: async (address, session, callback) => {
        await this._handleMailFrom(address, session, callback);
      },

      onRcptTo: async (address, session, callback) => {
        await this._handleRcptTo(address, session, callback, isMta);
      },

      onData: async (stream, session, callback) => {
        await this._handleData(stream, session, callback);
      },

      onClose: (session) => {
        logger.debug('SMTP connection closed', { id: session.id, ip: session.remoteAddress });
      },
    };

    if (!secure) {
      serverOptions.allowInsecureAuth = true;
      serverOptions.starttls = true;
    }

    const server = new SMTPServer(serverOptions);

    server.on('error', (err) => {
      logger.error(`SMTP ${name} error`, { error: err.message });
    });

    server.listen(port, '0.0.0.0', () => {
      logger.info(`SMTP ${name} listening on port ${port}`);
    });

    return server;
  }

  async _handleConnect(session, callback, isMta) {
    const ip = session.remoteAddress;
    logger.debug('SMTP connect', { ip, id: session.id });

    if (!isMta) return callback();

    // Check blocklist
    const blocked = await db.query(
      "SELECT id FROM blocklist WHERE type = 'ip' AND value = $1",
      [ip]
    );
    if (blocked.rows.length) {
      return callback(new Error('550 Your IP is blocked'));
    }

    return callback();
  }

  async _handleAuth(auth, session, callback) {
    const ip = session.remoteAddress;
    const failKey = `auth:${ip}`;

    try {
      // Rate limit auth attempts
      const failures = this._authFailures.get(failKey) || 0;
      if (failures >= config.limits.maxAuthFailures) {
        return callback(new Error('421 Too many auth failures, try later'));
      }

      const [username, domain] = (auth.username || '').split('@');
      if (!username || !domain) {
        this._trackAuthFailure(failKey);
        return callback(new Error('535 Invalid credentials'));
      }

      const result = await db.query(
        `SELECT mb.id, mb.password_hash, mb.active, mb.can_send
         FROM mailboxes mb
         JOIN domains d ON d.id = mb.domain_id
         WHERE mb.username = $1 AND d.name = $2`,
        [username, domain]
      );

      if (!result.rows.length) {
        this._trackAuthFailure(failKey);
        return callback(new Error('535 Invalid credentials'));
      }

      const mailbox = result.rows[0];
      if (!mailbox.active) {
        return callback(new Error('535 Account disabled'));
      }

      const bcrypt = require('bcryptjs');
      const valid = await bcrypt.compare(auth.password || '', mailbox.password_hash);

      if (!valid) {
        this._trackAuthFailure(failKey);
        return callback(new Error('535 Invalid credentials'));
      }

      // Clear failure count on success
      this._authFailures.delete(failKey);
      session.user = { id: mailbox.id, email: `${username}@${domain}`, domain };
      callback(null, { user: session.user });
    } catch (err) {
      logger.error('SMTP auth error', { error: err.message });
      callback(new Error('421 Service temporarily unavailable'));
    }
  }

  _trackAuthFailure(key) {
    const count = (this._authFailures.get(key) || 0) + 1;
    this._authFailures.set(key, count);
    // Auto-clear after ban duration
    setTimeout(() => this._authFailures.delete(key), config.limits.authBanDurationMin * 60 * 1000);
  }

  async _handleMailFrom(address, session, callback) {
    // Check sender blocklist
    const blocked = await db.query(
      "SELECT id FROM blocklist WHERE (type = 'email' AND value = $1) OR (type = 'domain' AND value = $2)",
      [address.address, address.address.split('@')[1]]
    );
    if (blocked.rows.length) {
      return callback(new Error('550 Sender blocked'));
    }
    return callback();
  }

  async _handleRcptTo(address, session, callback, isMta) {
    const [localPart, domain] = (address.address || '').split('@');

    try {
      // Check if domain is local
      const domainResult = await db.query(
        'SELECT id FROM domains WHERE name = $1 AND active = TRUE',
        [domain]
      );

      if (!domainResult.rows.length) {
        // Domain not local - only allow relay if authenticated (submission port)
        if (session.user) {
          // Authenticated user relaying - allowed
          return callback();
        }
        return callback(new Error('550 Relay denied'));
      }

      // Local domain - check mailbox exists
      const mailboxResult = await db.query(
        `SELECT mb.id FROM mailboxes mb
         WHERE mb.username = $1 AND mb.domain_id = $2 AND mb.active = TRUE AND mb.can_receive = TRUE`,
        [localPart, domainResult.rows[0].id]
      );

      if (!mailboxResult.rows.length) {
        // Check aliases
        const aliasResult = await db.query(
          `SELECT a.destination FROM aliases a
           WHERE a.source_local = $1 AND a.domain_id = $2 AND a.active = TRUE`,
          [localPart, domainResult.rows[0].id]
        );

        if (!aliasResult.rows.length) {
          // Check catch-all
          const catchAll = await db.query(
            'SELECT catch_all FROM domains WHERE id = $1 AND catch_all IS NOT NULL',
            [domainResult.rows[0].id]
          );
          if (!catchAll.rows.length) {
            return callback(new Error('550 No such user'));
          }
        }
      }

      return callback();
    } catch (err) {
      logger.error('RCPT TO error', { error: err.message });
      return callback(new Error('421 Temporary failure'));
    }
  }

  async _handleData(stream, session, callback) {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', async () => {
      try {
        const rawMessage = Buffer.concat(chunks);
        const parsed = await simpleParser(rawMessage);

        // Verify DKIM/SPF/DMARC for inbound
        const authResults = await DkimService.verify(rawMessage.toString());
        logger.debug('Mail auth results', authResults);

        // Deliver to each recipient
        for (const rcpt of session.envelope.rcptTo) {
          await this._deliver(rcpt.address, rawMessage, parsed, authResults, session);
        }

        // Log SMTP transaction
        await db.query(
          `INSERT INTO smtp_logs
            (message_id_hdr, direction, from_address, to_address, client_ip, status,
             spf_result, dkim_result, dmarc_result, bytes)
           VALUES ($1, 'inbound', $2, $3, $4, 'accepted', $5, $6, $7, $8)`,
          [
            parsed.messageId || null,
            session.envelope.mailFrom.address,
            session.envelope.rcptTo.map(r => r.address).join(', '),
            session.remoteAddress,
            authResults.spf,
            authResults.dkim,
            authResults.dmarc,
            rawMessage.length,
          ]
        );

        callback(null, 'Message accepted');
      } catch (err) {
        logger.error('SMTP data error', { error: err.message });
        callback(new Error('451 Processing error, try again later'));
      }
    });
  }

  async _deliver(recipientEmail, rawMessage, parsed, authResults, session) {
    const [localPart, domain] = recipientEmail.split('@');

    const domainResult = await db.query(
      'SELECT id FROM domains WHERE name = $1 AND active = TRUE',
      [domain]
    );
    if (!domainResult.rows.length) return; // External relay handled elsewhere

    const domainId = domainResult.rows[0].id;

    // Check for alias
    const aliasResult = await db.query(
      'SELECT destination FROM aliases WHERE source_local = $1 AND domain_id = $2 AND active = TRUE',
      [localPart, domainId]
    );

    if (aliasResult.rows.length) {
      // Re-deliver to alias destination
      await this._deliver(aliasResult.rows[0].destination, rawMessage, parsed, authResults, session);
      return;
    }

    const mailboxResult = await db.query(
      `SELECT mb.id, mb.uid_next, mb.quota_mb, mb.used_bytes
       FROM mailboxes mb
       WHERE mb.username = $1 AND mb.domain_id = $2 AND mb.active = TRUE`,
      [localPart, domainId]
    );

    if (!mailboxResult.rows.length) return;
    const mailbox = mailboxResult.rows[0];

    // Quota check
    const maxBytes = mailbox.quota_mb * 1024 * 1024;
    if (mailbox.used_bytes + rawMessage.length > maxBytes) {
      logger.warn('Mailbox quota exceeded', { email: recipientEmail });
      return;
    }

    // Get or create INBOX folder
    const folderResult = await db.query(
      "SELECT id, uid_next FROM folders WHERE mailbox_id = $1 AND name = 'INBOX'",
      [mailbox.id]
    );

    let folderId, uid;
    if (folderResult.rows.length) {
      folderId = folderResult.rows[0].id;
      uid = folderResult.rows[0].uid_next;
      await db.query(
        'UPDATE folders SET uid_next = uid_next + 1, total_msgs = total_msgs + 1, unseen_msgs = unseen_msgs + 1 WHERE id = $1',
        [folderId]
      );
    } else {
      const newFolder = await db.query(
        `INSERT INTO folders (mailbox_id, name, special_use, uid_next, total_msgs, unseen_msgs)
         VALUES ($1, 'INBOX', '\\Inbox', 2, 1, 1) RETURNING id`,
        [mailbox.id]
      );
      folderId = newFolder.rows[0].id;
      uid = 1;
    }

    // Store raw message
    const rawPath = await MessageStore.store(mailbox.id, uuidv4(), rawMessage);

    // Insert message record
    const toAddresses = (parsed.to?.value || []).map(a => ({ name: a.name, email: a.address }));
    const ccAddresses = (parsed.cc?.value || []).map(a => ({ name: a.name, email: a.address }));

    await db.query(
      `INSERT INTO messages
        (mailbox_id, folder_id, uid, message_id, subject, from_address, from_name,
         to_addresses, cc_addresses, size_bytes, headers, body_text, body_html,
         has_attachments, raw_path, spf_result, dkim_result, dmarc_result, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())`,
      [
        mailbox.id,
        folderId,
        uid,
        parsed.messageId || null,
        parsed.subject || '',
        parsed.from?.value?.[0]?.address || session.envelope.mailFrom.address,
        parsed.from?.value?.[0]?.name || '',
        JSON.stringify(toAddresses),
        JSON.stringify(ccAddresses),
        rawMessage.length,
        JSON.stringify(Object.fromEntries(parsed.headers || [])),
        parsed.text || '',
        parsed.html || '',
        (parsed.attachments || []).length > 0,
        rawPath,
        authResults.spf,
        authResults.dkim,
        authResults.dmarc,
      ]
    );

    // Update mailbox usage
    await db.query(
      'UPDATE mailboxes SET used_bytes = used_bytes + $1, uid_next = uid_next + 1 WHERE id = $2',
      [rawMessage.length, mailbox.id]
    );

    logger.info('Message delivered', { to: recipientEmail, uid, size: rawMessage.length });
  }

  async stop() {
    for (const server of this.servers) {
      await new Promise(resolve => server.close(resolve));
    }
    logger.info('SMTP servers stopped');
  }
}

module.exports = SmtpInboundServer;
