#!/usr/bin/env node

import mongoose from 'mongoose';
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Settings from '../src/models/Settings.js';
import { ensureSettingsSingleton } from '../src/utils/settingsSingleton.js';

function loadEnvironment() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const projectRoot = join(__dirname, '..', '..');

  const envPaths = [
    join(projectRoot, '.env'),
    join(projectRoot, 'server', '.env'),
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      loadEnv({ path: envPath, quiet: true });
      return envPath;
    }
  }

  return null;
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log('Usage: node server/scripts/reconcile-settings-singleton.js');
    console.log('  Promotes legacy settings records into canonical _id="settings".');
    process.exit(0);
  }
}

async function main() {
  const envPath = loadEnvironment();
  parseArgs(process.argv);

  const mongoUri = process.env.MONGO_URI
    || (process.env.MONGO_PORT ? `mongodb://localhost:${process.env.MONGO_PORT}/qlicker` : '');

  if (!mongoUri) {
    console.error('MONGO_URI or MONGO_PORT must be set.');
    process.exit(1);
  }

  console.log('Reconciling settings singleton...');
  console.log(`Mongo URI: ${mongoUri}`);
  console.log(`Env file: ${envPath || 'not found (using process env only)'}`);

  await mongoose.connect(mongoUri);

  const result = await ensureSettingsSingleton({
    warn: (...args) => console.warn(...args),
  });

  const canonical = await Settings.findById('settings').lean();

  console.log('\nResult');
  console.log(`  removedDuplicates: ${result.removedDuplicates}`);
  console.log(`  seededFromDuplicate: ${result.seededFromDuplicate}`);
  console.log(`  mergedFromDuplicates: ${result.mergedFromDuplicates}`);
  if (Array.isArray(result.mergedFromDuplicateIds) && result.mergedFromDuplicateIds.length > 0) {
    console.log(`  mergedFromDuplicateIds: ${result.mergedFromDuplicateIds.join(', ')}`);
  }

  if (canonical) {
    console.log('\nCanonical settings snapshot');
    console.log(`  _id: ${canonical._id}`);
    console.log(`  SSO_enabled: ${canonical.SSO_enabled === true ? 'true' : 'false'}`);
    console.log(`  storageType: ${canonical.storageType || 'local'}`);
    console.log(`  AWS_bucket: ${canonical.AWS_bucket ? '[set]' : '[empty]'}`);
    console.log(`  Azure_storageAccount: ${canonical.Azure_storageAccount || canonical.Azure_accountName ? '[set]' : '[empty]'}`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    // noop
  }
  process.exit(1);
});
