#!/usr/bin/env node
// Prints the wrangler command that adds one passcode to the PASSCODES KV
// namespace. Run it, then copy-paste and run the command it prints — this
// script never talks to Cloudflare itself, it only does the hashing so you
// never have to compute a SHA-256 by hand.
//
// Usage:
//   node scripts/add-passcode.mjs "some-long-random-passcode" "alice"
//
// To revoke someone later without deleting their history, put the same
// key again with {"active": false}.

import { createHash } from 'node:crypto';

const [passcode, name] = process.argv.slice(2);

if (!passcode || !name) {
  console.error('Usage: node scripts/add-passcode.mjs <passcode> <name>');
  console.error('Example: node scripts/add-passcode.mjs "correct-horse-battery-staple" "alice"');
  process.exit(1);
}

if (passcode.length < 12) {
  console.error(
    `Warning: "${passcode}" is short (${passcode.length} chars) for something that guards a real API key. Consider a longer, randomly generated passcode — e.g. run:\n  node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`
  );
}

const hash = createHash('sha256').update(passcode, 'utf8').digest('hex');
const value = JSON.stringify({ name, active: true });

console.log('\nRun this to grant access:\n');
console.log(
  `  wrangler kv key put --binding=PASSCODES "passcode:${hash}" '${value}' --remote\n`
);
console.log(`Give "${name}" the passcode itself (not the hash above) out of band.`);
console.log('To revoke later, run the same command with "active":false in the JSON.');
