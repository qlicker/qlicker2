#!/usr/bin/env node
import { buildQlickerSsoSettingsPayload, getSsoConfig } from './lib/qlicker-sso-settings.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const config = getSsoConfig();
const payload = buildQlickerSsoSettingsPayload(config);
const apiBase = String(args['api-url'] || config.qlickerApiUrl).replace(/\/$/, '');
const token = args.token || process.env.QCLICKER_ADMIN_TOKEN || '';
const adminEmail = args['admin-email'] || process.env.QCLICKER_ADMIN_EMAIL || '';
const adminPassword = args['admin-password'] || process.env.QCLICKER_ADMIN_PASSWORD || '';

let accessToken = token;
if (!accessToken) {
  if (!adminEmail || !adminPassword) {
    throw new Error('Provide --token or both --admin-email and --admin-password to apply settings.');
  }
  const loginRes = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !loginBody.token) {
    throw new Error(`Admin login failed (${loginRes.status}): ${JSON.stringify(loginBody)}`);
  }
  accessToken = loginBody.token;
}

const patchRes = await fetch(`${apiBase}/settings`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'X-Requested-With': 'XMLHttpRequest',
  },
  body: JSON.stringify(payload),
});
const patchBody = await patchRes.json().catch(() => ({}));
if (!patchRes.ok) {
  throw new Error(`Settings PATCH failed (${patchRes.status}): ${JSON.stringify(patchBody)}`);
}
console.log('Applied Qlicker SSO settings payload.');
console.log(JSON.stringify(patchBody, null, 2));
