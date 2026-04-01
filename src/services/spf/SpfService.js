'use strict';

const dns = require('dns').promises;
const logger = require('../../utils/logger');

/**
 * SPF (Sender Policy Framework) verification - RFC 7208
 * and DMARC (Domain-based Message Authentication) policy enforcement
 */
class SpfService {
  /**
   * Check SPF for a given sender IP and email domain
   * Returns: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror'
   */
  static async check(clientIp, fromAddress, heloName) {
    try {
      const domain = fromAddress.includes('@') ? fromAddress.split('@')[1] : fromAddress;
      const records = await dns.resolveTxt(domain).catch(() => []);

      const spfRecord = records
        .map(r => r.join(''))
        .find(r => r.toLowerCase().startsWith('v=spf1'));

      if (!spfRecord) return 'none';

      return SpfService._evaluate(spfRecord, clientIp, domain);
    } catch (err) {
      logger.debug('SPF check error', { error: err.message });
      return 'temperror';
    }
  }

  static _evaluate(record, clientIp, domain) {
    const terms = record.split(/\s+/);
    // Skip 'v=spf1'
    for (const term of terms.slice(1)) {
      const lower = term.toLowerCase();

      // All mechanism
      if (lower === 'all' || lower === '+all') return 'pass';
      if (lower === '-all') return 'fail';
      if (lower === '~all') return 'softfail';
      if (lower === '?all') return 'neutral';

      // ip4 / ip6
      if (lower.startsWith('ip4:') || lower.startsWith('+ip4:')) {
        const cidr = term.split(':')[1];
        if (SpfService._ipInCidr(clientIp, cidr)) return 'pass';
      }
      if (lower.startsWith('-ip4:')) {
        const cidr = term.split(':')[1];
        if (SpfService._ipInCidr(clientIp, cidr)) return 'fail';
      }
      if (lower.startsWith('~ip4:')) {
        const cidr = term.split(':')[1];
        if (SpfService._ipInCidr(clientIp, cidr)) return 'softfail';
      }
    }

    return 'neutral';
  }

  static _ipInCidr(ip, cidr) {
    try {
      if (!cidr.includes('/')) return ip === cidr;
      const [network, bits] = cidr.split('/');
      const mask = ~(2 ** (32 - parseInt(bits)) - 1);
      const ipNum = SpfService._ipToNum(ip);
      const netNum = SpfService._ipToNum(network);
      return (ipNum & mask) === (netNum & mask);
    } catch {
      return false;
    }
  }

  static _ipToNum(ip) {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
  }

  /**
   * Generate an SPF record string for a domain
   */
  static generateRecord(options = {}) {
    const {
      serverIp,
      includeHosts = [],
      policy = 'softfail',  // ~all by default (recommended for new setups)
    } = options;

    const parts = ['v=spf1'];
    if (serverIp) parts.push(`ip4:${serverIp}`);
    for (const host of includeHosts) parts.push(`include:${host}`);

    const policyMap = { pass: '+all', fail: '-all', softfail: '~all', neutral: '?all' };
    parts.push(policyMap[policy] || '~all');

    return parts.join(' ');
  }
}

/**
 * DMARC policy enforcement
 */
class DmarcService {
  /**
   * Check DMARC policy for a domain
   * Returns the policy record or null
   */
  static async getPolicy(domain) {
    try {
      const dmarcDomain = `_dmarc.${domain}`;
      const records = await dns.resolveTxt(dmarcDomain).catch(() => []);
      const record = records.map(r => r.join('')).find(r => r.toLowerCase().startsWith('v=dmarc1'));
      if (!record) return null;

      const parsed = {};
      record.split(';').forEach(part => {
        const [k, v] = part.trim().split('=');
        if (k && v) parsed[k.trim().toLowerCase()] = v.trim();
      });

      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Evaluate DMARC alignment and return result
   * spfResult/dkimResult: 'pass' | 'fail' | 'none' etc.
   */
  static async evaluate(fromDomain, spfResult, dkimResult) {
    const policy = await DmarcService.getPolicy(fromDomain);
    if (!policy) return { result: 'none', action: 'accept', policy: null };

    const p = policy.p || 'none';
    const spfPass = spfResult === 'pass';
    const dkimPass = dkimResult === 'pass';

    if (spfPass || dkimPass) {
      return { result: 'pass', action: 'accept', policy: p };
    }

    // Neither passed
    let action = 'accept';
    if (p === 'reject') action = 'reject';
    else if (p === 'quarantine') action = 'quarantine';

    return { result: 'fail', action, policy: p };
  }

  /**
   * Generate a DMARC DNS TXT record
   */
  static generateRecord(options = {}) {
    const {
      policy = 'none',       // none | quarantine | reject
      subdomainPolicy,
      ruaEmail,              // aggregate report email
      rufEmail,              // forensic report email
      pct = 100,             // percentage of messages subject to policy
      adkim = 'r',           // DKIM alignment: r=relaxed, s=strict
      aspf = 'r',            // SPF alignment: r=relaxed, s=strict
    } = options;

    const parts = ['v=DMARC1', `p=${policy}`];
    if (subdomainPolicy) parts.push(`sp=${subdomainPolicy}`);
    if (adkim !== 'r') parts.push(`adkim=${adkim}`);
    if (aspf !== 'r') parts.push(`aspf=${aspf}`);
    if (ruaEmail) parts.push(`rua=mailto:${ruaEmail}`);
    if (rufEmail) parts.push(`ruf=mailto:${rufEmail}`);
    if (pct !== 100) parts.push(`pct=${pct}`);

    return parts.join('; ');
  }
}

module.exports = { SpfService, DmarcService };
