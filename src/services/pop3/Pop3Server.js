'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const config = require('../../config');
const db = require('../../database/connection');
const logger = require('../../utils/logger');
const MessageStore = require('../storage/MessageStore');

/**
 * POP3 Server (RFC 1939)
 * Supports: USER, PASS, STAT, LIST, RETR, DELE, NOOP, RSET, QUIT, TOP, UIDL, CAPA
 */
class Pop3Server {
  constructor() {
    this.servers = [];
  }

  async start() {
    const tlsOpts = this._loadTls();

    // Port 110 - POP3
    const server = net.createServer(socket => this._handleConnection(socket, false));
    server.on('error', err => logger.error('POP3 error', { error: err.message }));
    server.listen(config.ports.pop3, '0.0.0.0', () => {
      logger.info(`POP3 server listening on port ${config.ports.pop3}`);
    });

    // Port 995 - POP3S
    const secureServer = tls.createServer(tlsOpts, socket => this._handleConnection(socket, true));
    secureServer.on('error', err => logger.error('POP3S error', { error: err.message }));
    secureServer.listen(config.ports.pop3s, '0.0.0.0', () => {
      logger.info(`POP3S server listening on port ${config.ports.pop3s}`);
    });

    this.servers = [server, secureServer];
  }

  _loadTls() {
    try {
      if (fs.existsSync(config.tls.cert) && fs.existsSync(config.tls.key)) {
        return { key: fs.readFileSync(config.tls.key), cert: fs.readFileSync(config.tls.cert) };
      }
    } catch {}
    const forge = require('node-forge');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey; cert.serialNumber = '01';
    cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    cert.setSubject(attrs); cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
  }

  _handleConnection(socket, isTls) {
    const session = {
      state: 'AUTHORIZATION',
      user: null,
      username: null,
      messages: [],
      deletedIds: new Set(),
    };

    socket.setEncoding('utf8');
    socket.setTimeout(300000);

    logger.debug('POP3 connect', { ip: socket.remoteAddress, tls: isTls });
    socket.write(`+OK ${config.app.name} POP3 Service Ready\r\n`);

    let buffer = '';

    socket.on('data', data => {
      buffer += data;
      let pos;
      while ((pos = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.substring(0, pos).trim();
        buffer = buffer.substring(pos + 2);
        this._processCommand(socket, session, line).catch(err => {
          logger.error('POP3 command error', { error: err.message });
          socket.write('-ERR Internal error\r\n');
        });
      }
    });

    socket.on('timeout', () => { socket.write('-ERR Timeout\r\n'); socket.destroy(); });
    socket.on('error', err => logger.debug('POP3 socket error', { error: err.message }));
    socket.on('close', () => logger.debug('POP3 disconnect'));
  }

  async _processCommand(socket, session, line) {
    const [cmd, ...argParts] = line.split(/\s+/);
    const args = argParts.join(' ');
    const command = (cmd || '').toUpperCase();

    logger.debug('POP3 cmd', { cmd: command, args: args.substring(0, 50) });

    switch (command) {
      case 'CAPA':
        socket.write('+OK Capabilities:\r\nUSER\r\nPASS\r\nUIDL\r\nTOP\r\nEXPIRE NEVER\r\nRESP-CODES\r\n.\r\n');
        break;

      case 'USER':
        if (session.state !== 'AUTHORIZATION') return socket.write('-ERR Wrong state\r\n');
        session.username = args.trim();
        socket.write('+OK\r\n');
        break;

      case 'PASS':
        if (session.state !== 'AUTHORIZATION') return socket.write('-ERR Wrong state\r\n');
        if (!session.username) return socket.write('-ERR No username given\r\n');
        await this._handlePass(socket, session, args.trim());
        break;

      case 'APOP':
        socket.write('-ERR APOP not supported\r\n');
        break;

      case 'STAT':
        if (session.state !== 'TRANSACTION') return socket.write('-ERR Not authenticated\r\n');
        {
          const active = session.messages.filter(m => !session.deletedIds.has(m.id));
          const totalSize = active.reduce((s, m) => s + (m.size_bytes || 0), 0);
          socket.write(`+OK ${active.length} ${totalSize}\r\n`);
        }
        break;

      case 'LIST':
        if (session.state !== 'TRANSACTION') return socket.write('-ERR Not authenticated\r\n');
        await this._handleList(socket, session, args);
        break;

      case 'UIDL':
        if (session.state !== 'TRANSACTION') return socket.write('-ERR Not authenticated\r\n');
        await this._handleUidl(socket, session, args);
        break;

      case 'RETR':
        if (session.state !== 'TRANSACTION') return socket.write('-ERR Not authenticated\r\n');
        await this._handleRetr(socket, session, parseInt(args));
        break;

      case 'TOP':
        if (session.state !== 'TRANSACTION') return socket.write('-ERR Not authenticated\r\n');
        await this._handleTop(socket, session, args);
        break;

      case 'DELE':
        if (session.state !== 'TRANSACTION') return socket.write('-ERR Not authenticated\r\n');
        {
          const msgNum = parseInt(args);
          const msg = session.messages[msgNum - 1];
          if (!msg || session.deletedIds.has(msg.id)) return socket.write('-ERR No such message\r\n');
          session.deletedIds.add(msg.id);
          socket.write(`+OK message ${msgNum} deleted\r\n`);
        }
        break;

      case 'NOOP':
        socket.write('+OK\r\n');
        break;

      case 'RSET':
        if (session.state !== 'TRANSACTION') return socket.write('-ERR Not authenticated\r\n');
        session.deletedIds.clear();
        socket.write(`+OK ${session.messages.length} messages\r\n`);
        break;

      case 'QUIT':
        await this._handleQuit(socket, session);
        break;

      default:
        socket.write('-ERR Unknown command\r\n');
    }
  }

  async _handlePass(socket, session, password) {
    const [localPart, domain] = (session.username || '').split('@');
    if (!localPart || !domain) return socket.write('-ERR [AUTH] Invalid username\r\n');

    const result = await db.query(
      `SELECT mb.id, mb.password_hash, mb.active
       FROM mailboxes mb JOIN domains d ON d.id = mb.domain_id
       WHERE mb.username = $1 AND d.name = $2`,
      [localPart, domain]
    );

    if (!result.rows.length || !result.rows[0].active) {
      return socket.write('-ERR [AUTH] Invalid credentials\r\n');
    }

    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) return socket.write('-ERR [AUTH] Invalid credentials\r\n');

    session.user = { id: result.rows[0].id, email: session.username };

    // Load messages from INBOX
    const msgs = await db.query(
      `SELECT m.id, m.uid, m.size_bytes, m.message_id, m.raw_path
       FROM messages m
       JOIN folders f ON f.id = m.folder_id
       WHERE m.mailbox_id = $1 AND f.name = 'INBOX' AND NOT m.is_deleted
       ORDER BY m.received_at ASC`,
      [session.user.id]
    );

    session.messages = msgs.rows;
    session.state = 'TRANSACTION';
    socket.write(`+OK Maildrop ready, ${msgs.rows.length} messages\r\n`);
  }

  async _handleList(socket, session, args) {
    const msgNum = args ? parseInt(args) : null;

    if (msgNum) {
      const msg = session.messages[msgNum - 1];
      if (!msg || session.deletedIds.has(msg.id)) return socket.write('-ERR No such message\r\n');
      socket.write(`+OK ${msgNum} ${msg.size_bytes || 0}\r\n`);
    } else {
      const active = session.messages
        .map((m, i) => ({ ...m, num: i + 1 }))
        .filter(m => !session.deletedIds.has(m.id));
      const totalSize = active.reduce((s, m) => s + (m.size_bytes || 0), 0);
      socket.write(`+OK ${active.length} messages (${totalSize} octets)\r\n`);
      for (const m of active) {
        socket.write(`${m.num} ${m.size_bytes || 0}\r\n`);
      }
      socket.write('.\r\n');
    }
  }

  async _handleUidl(socket, session, args) {
    const msgNum = args ? parseInt(args) : null;
    const makeUid = msg => msg.message_id ? msg.message_id.replace(/[<>\s]/g, '') : msg.uid.toString();

    if (msgNum) {
      const msg = session.messages[msgNum - 1];
      if (!msg || session.deletedIds.has(msg.id)) return socket.write('-ERR No such message\r\n');
      socket.write(`+OK ${msgNum} ${makeUid(msg)}\r\n`);
    } else {
      socket.write('+OK\r\n');
      session.messages.forEach((m, i) => {
        if (!session.deletedIds.has(m.id)) {
          socket.write(`${i + 1} ${makeUid(m)}\r\n`);
        }
      });
      socket.write('.\r\n');
    }
  }

  async _handleRetr(socket, session, msgNum) {
    const msg = session.messages[msgNum - 1];
    if (!msg || session.deletedIds.has(msg.id)) return socket.write('-ERR No such message\r\n');

    let content;
    if (msg.raw_path) {
      content = await MessageStore.read(msg.raw_path);
    }

    if (!content) {
      // Build minimal message
      const msgData = await db.query(
        'SELECT * FROM messages WHERE id = $1',
        [msg.id]
      );
      if (!msgData.rows.length) return socket.write('-ERR Message not found\r\n');
      const m = msgData.rows[0];
      content = Buffer.from(
        `From: ${m.from_address}\r\nSubject: ${m.subject || ''}\r\nDate: ${new Date(m.received_at).toUTCString()}\r\n\r\n${m.body_text || m.body_html || '(no content)'}`
      );
    }

    // Mark as seen
    await db.query('UPDATE messages SET is_seen = TRUE WHERE id = $1', [msg.id]);

    socket.write(`+OK ${content.length} octets\r\n`);
    // Byte-stuff lines starting with dot
    const lines = content.toString().split('\r\n');
    for (const line of lines) {
      socket.write((line.startsWith('.') ? '.' + line : line) + '\r\n');
    }
    socket.write('.\r\n');
  }

  async _handleTop(socket, session, args) {
    const [msgNumStr, linesStr] = args.split(/\s+/);
    const msgNum = parseInt(msgNumStr);
    const maxLines = parseInt(linesStr) || 0;

    const msg = session.messages[msgNum - 1];
    if (!msg || session.deletedIds.has(msg.id)) return socket.write('-ERR No such message\r\n');

    const msgData = await db.query('SELECT * FROM messages WHERE id = $1', [msg.id]);
    if (!msgData.rows.length) return socket.write('-ERR Message not found\r\n');

    const m = msgData.rows[0];
    const headers = `From: ${m.from_address}\r\nSubject: ${m.subject || ''}\r\nDate: ${new Date(m.received_at).toUTCString()}\r\n`;
    const bodyLines = (m.body_text || '').split('\n').slice(0, maxLines).join('\r\n');

    socket.write('+OK\r\n');
    socket.write(headers + '\r\n');
    if (maxLines > 0) socket.write(bodyLines + '\r\n');
    socket.write('.\r\n');
  }

  async _handleQuit(socket, session) {
    if (session.state === 'TRANSACTION' && session.deletedIds.size > 0) {
      for (const id of session.deletedIds) {
        await db.query('UPDATE messages SET is_deleted = TRUE WHERE id = $1', [id]);
      }
    }
    session.state = 'UPDATE';
    socket.write('+OK CloudMail POP3 server signing off\r\n');
    socket.end();
  }

  async stop() {
    for (const server of this.servers) server.close();
    logger.info('POP3 servers stopped');
  }
}

module.exports = Pop3Server;
