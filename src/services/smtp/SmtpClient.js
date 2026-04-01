'use strict';

const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const config = require('../../config');
const db = require('../../database/connection');
const logger = require('../../utils/logger');
const DkimService = require('../dkim/DkimService');

class SmtpClient {
  constructor() {
    this._transporters = new Map();
  }

  /**
   * Send an email message
   * @param {Object} options - nodemailer message options
   * @param {string} fromDomain - Domain to use for DKIM signing
   */
  async send(options, fromDomain) {
    try {
      const transport = await this._getTransport(fromDomain);

      // Add DKIM signing if available
      if (fromDomain) {
        const keyInfo = await DkimService.getPrivateKey(fromDomain);
        if (keyInfo) {
          transport.options.dkim = {
            domainName: fromDomain,
            keySelector: keyInfo.selector,
            privateKey: keyInfo.privateKey,
          };
        }
      }

      const info = await transport.sendMail({
        ...options,
        headers: {
          'X-Mailer': `${config.app.name}/1.0`,
          ...(options.headers || {}),
        },
      });

      logger.info('Email sent', {
        messageId: info.messageId,
        to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
        accepted: info.accepted,
        rejected: info.rejected,
      });

      // Log outbound
      await db.query(
        `INSERT INTO smtp_logs
          (message_id_hdr, direction, from_address, to_address, status, response_code, response_msg, bytes)
         VALUES ($1, 'outbound', $2, $3, 'delivered', 250, $4, $5)`,
        [
          info.messageId || null,
          options.from,
          Array.isArray(options.to) ? options.to[0] : options.to,
          info.response || 'OK',
          JSON.stringify(options).length,
        ]
      );

      return { success: true, messageId: info.messageId };
    } catch (err) {
      logger.error('Email send error', { error: err.message, to: options.to });

      await db.query(
        `INSERT INTO smtp_logs
          (direction, from_address, to_address, status, response_msg)
         VALUES ('outbound', $1, $2, 'bounced', $3)`,
        [options.from, Array.isArray(options.to) ? options.to[0] : options.to, err.message]
      ).catch(() => {});

      return { success: false, error: err.message };
    }
  }

  /**
   * Get or create a nodemailer transport for the given domain
   */
  async _getTransport(fromDomain) {
    // Use configured relay if available
    if (config.relay.host) {
      const key = `relay:${config.relay.host}`;
      if (!this._transporters.has(key)) {
        this._transporters.set(key, nodemailer.createTransport({
          host: config.relay.host,
          port: config.relay.port,
          secure: config.relay.port === 465,
          auth: config.relay.user ? {
            user: config.relay.user,
            pass: config.relay.pass,
          } : undefined,
        }));
      }
      return this._transporters.get(key);
    }

    // Direct delivery - look up MX records
    if (fromDomain) {
      return nodemailer.createTransport({
        direct: true,
        name: fromDomain,
      });
    }

    // Fallback: direct local delivery
    return nodemailer.createTransport({
      host: 'localhost',
      port: config.ports.smtpSubmission,
      secure: false,
      ignoreTLS: true,
    });
  }

  /**
   * Send to a specific SMTP host (used for direct MX delivery)
   */
  async sendDirect(options, mxHost, fromDomain) {
    const transport = nodemailer.createTransport({
      host: mxHost,
      port: 25,
      secure: false,
      name: fromDomain || 'localhost',
      ignoreTLS: false,
      opportunisticTLS: true,
    });

    // Sign with DKIM
    if (fromDomain) {
      const keyInfo = await DkimService.getPrivateKey(fromDomain);
      if (keyInfo) {
        transport.options.dkim = {
          domainName: fromDomain,
          keySelector: keyInfo.selector,
          privateKey: keyInfo.privateKey,
        };
      }
    }

    return transport.sendMail(options);
  }

  /**
   * Resolve MX records for a domain
   */
  static async resolveMx(domain) {
    try {
      const records = await dns.resolveMx(domain);
      return records.sort((a, b) => a.priority - b.priority);
    } catch (err) {
      logger.debug('MX lookup failed', { domain, error: err.message });
      return [];
    }
  }

  /**
   * Verify SMTP connection to remote server
   */
  async verify(host, port = 25) {
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
    });
    return transport.verify();
  }
}

// Singleton
const client = new SmtpClient();
module.exports = client;
