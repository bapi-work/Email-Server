'use strict';

const crypto = require('crypto');
const forge = require('node-forge');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const db = require('../../database/connection');
const logger = require('../../utils/logger');

class DkimService {
  /**
   * Generate a new RSA key pair for DKIM
   */
  static generateKeyPair(bits = 2048) {
    const keypair = forge.pki.rsa.generateKeyPair({ bits, e: 0x10001 });
    const privateKeyPem = forge.pki.privateKeyToPem(keypair.privateKey);
    const publicKeyPem = forge.pki.publicKeyToPem(keypair.publicKey);

    // Extract the raw public key for the DNS TXT record (base64 DER)
    const publicKeyDer = forge.asn1.toDer(forge.pki.publicKeyToAsn1(keypair.publicKey)).getBytes();
    const publicKeyB64 = Buffer.from(publicKeyDer, 'binary').toString('base64');

    return { privateKeyPem, publicKeyPem, publicKeyB64 };
  }

  /**
   * Save DKIM keys for a domain
   */
  static async saveKeys(domainName, selector, privateKeyPem, publicKeyPem, publicKeyB64) {
    const keyDir = config.dkim.keyDir;
    if (!fs.existsSync(keyDir)) {
      fs.mkdirSync(keyDir, { recursive: true });
    }

    const keyPath = path.join(keyDir, `${domainName}.${selector}.private.pem`);
    fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });

    await db.query(
      `UPDATE domains
       SET dkim_selector = $1,
           dkim_private_key = $2,
           dkim_public_key = $3,
           dkim_enabled = TRUE,
           updated_at = NOW()
       WHERE name = $4`,
      [selector, privateKeyPem, publicKeyB64, domainName]
    );

    return { keyPath, publicKeyB64 };
  }

  /**
   * Load private key for a domain from DB
   */
  static async getPrivateKey(domainName) {
    const result = await db.query(
      'SELECT dkim_private_key, dkim_selector, dkim_enabled FROM domains WHERE name = $1',
      [domainName]
    );
    if (!result.rows.length || !result.rows[0].dkim_enabled) return null;
    return {
      privateKey: result.rows[0].dkim_private_key,
      selector: result.rows[0].dkim_selector,
    };
  }

  /**
   * Sign an email message with DKIM
   * @param {string} rawMessage - The full raw email message
   * @param {string} domain - Signing domain
   * @returns {string} - Message with DKIM-Signature header prepended
   */
  static async sign(rawMessage, domain) {
    try {
      const keyInfo = await DkimService.getPrivateKey(domain);
      if (!keyInfo) {
        logger.debug(`DKIM: no key for domain ${domain}, skipping signing`);
        return rawMessage;
      }

      const { privateKey, selector } = keyInfo;

      // Split headers from body
      const headerBodySplit = rawMessage.indexOf('\r\n\r\n');
      if (headerBodySplit === -1) return rawMessage;

      const headerSection = rawMessage.substring(0, headerBodySplit);
      const body = rawMessage.substring(headerBodySplit + 4);

      // Canonicalize body (simple)
      const canonBody = DkimService._canonicalizeBodySimple(body);
      const bodyHash = crypto.createHash('sha256').update(canonBody, 'binary').digest('base64');

      // Headers to sign
      const headersToSign = ['from', 'to', 'subject', 'date', 'message-id', 'mime-version', 'content-type'];
      const parsedHeaders = DkimService._parseHeaders(headerSection);
      const signedHeaderNames = [];
      const signedHeaderValues = [];

      for (const h of headersToSign) {
        const lh = h.toLowerCase();
        if (parsedHeaders[lh]) {
          signedHeaderNames.push(lh);
          signedHeaderValues.push(`${lh}:${parsedHeaders[lh].join(':')}`);
        }
      }

      const timestamp = Math.floor(Date.now() / 1000);
      const dkimHeaderBase = [
        `v=1`,
        `a=rsa-sha256`,
        `c=relaxed/simple`,
        `d=${domain}`,
        `s=${selector}`,
        `t=${timestamp}`,
        `bh=${bodyHash}`,
        `h=${signedHeaderNames.join(':')}`,
        `b=`,
      ].join('; ');

      // Canonicalize the DKIM header itself (relaxed)
      const dkimHeaderForSigning = `dkim-signature:${dkimHeaderBase}`;
      const dataToSign = [...signedHeaderValues, dkimHeaderForSigning].join('\r\n');

      // Sign with RSA-SHA256
      const sign = crypto.createSign('RSA-SHA256');
      sign.update(dataToSign);
      const signature = sign.sign(privateKey, 'base64');

      const dkimHeader = `DKIM-Signature: ${dkimHeaderBase}${signature}`;
      return `${dkimHeader}\r\n${rawMessage}`;
    } catch (err) {
      logger.error('DKIM signing error', { error: err.message, domain });
      return rawMessage;
    }
  }

  /**
   * Verify DKIM signature on an incoming message
   */
  static async verify(rawMessage) {
    try {
      const { authenticate } = require('mailauth');
      const result = await authenticate(rawMessage, {
        ip: '127.0.0.1',
        helo: 'localhost',
        sender: '',
        mta: 'cloudmail',
      });
      return {
        dkim: result.dkim?.status?.result || 'none',
        spf: result.spf?.status?.result || 'none',
        dmarc: result.dmarc?.status?.result || 'none',
        arc: result.arc?.status?.result || 'none',
      };
    } catch (err) {
      logger.debug('DKIM verify error', { error: err.message });
      return { dkim: 'error', spf: 'error', dmarc: 'error', arc: 'none' };
    }
  }

  /**
   * Generate the DNS TXT record value for DKIM
   */
  static getDnsTxtRecord(selector, domain, publicKeyB64) {
    return {
      name: `${selector}._domainkey.${domain}`,
      type: 'TXT',
      value: `v=DKIM1; k=rsa; p=${publicKeyB64}`,
    };
  }

  static _canonicalizeBodySimple(body) {
    // Simple canonicalization: strip trailing empty lines, ensure \r\n line endings
    let lines = body.replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    return lines.join('\r\n') + '\r\n';
  }

  static _parseHeaders(headerSection) {
    const headers = {};
    const lines = headerSection.split('\r\n');
    let currentName = null;

    for (const line of lines) {
      if (line.startsWith(' ') || line.startsWith('\t')) {
        if (currentName) headers[currentName][headers[currentName].length - 1] += ' ' + line.trim();
      } else {
        const idx = line.indexOf(':');
        if (idx > 0) {
          currentName = line.substring(0, idx).toLowerCase();
          const value = line.substring(idx + 1).trim();
          if (!headers[currentName]) headers[currentName] = [];
          headers[currentName].push(value);
        }
      }
    }
    return headers;
  }
}

module.exports = DkimService;
