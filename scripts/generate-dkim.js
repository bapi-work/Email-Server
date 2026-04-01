#!/usr/bin/env node
'use strict';
// Generate DKIM keys and optionally save to DB
// Usage: node scripts/generate-dkim.js <domain> [selector]

require('dotenv').config();

const db     = require('../src/database/connection');
const DkimService = require('../src/services/dkim/DkimService');

async function main() {
  const domain   = process.argv[2];
  const selector = process.argv[3] || 'mail';

  if (!domain) {
    console.error('Usage: node scripts/generate-dkim.js <domain> [selector]');
    process.exit(1);
  }

  const { privateKeyPem, publicKeyDns } = DkimService.generateKeyPair(2048);

  const result = await db.query(
    `UPDATE domains SET dkim_private_key = $1, dkim_public_key = $2, dkim_selector = $3, dkim_enabled = TRUE
     WHERE name = $4 RETURNING id, name`,
    [privateKeyPem, publicKeyDns, selector, domain]
  );

  if (!result.rows.length) {
    console.error(`Domain '${domain}' not found in database. Add it via the admin panel first.`);
    process.exit(1);
  }

  console.log(`\n✓ DKIM keys generated for: ${domain}\n`);
  console.log('Add this DNS TXT record:\n');
  console.log(`  Host:  ${selector}._domainkey.${domain}`);
  console.log(`  Value: v=DKIM1; k=rsa; p=${publicKeyDns}`);
  console.log(`  TTL:   3600\n`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err.message); process.exit(1); })
  .finally(() => db.close());
