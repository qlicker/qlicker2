#!/usr/bin/env node

import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

async function loadModule(moduleName, fallbackRelativePath) {
  try {
    return await import(moduleName);
  } catch (err) {
    const fallbackPath = join(projectRoot, 'server', 'node_modules', fallbackRelativePath);
    if (existsSync(fallbackPath)) {
      return import(pathToFileURL(fallbackPath).href);
    }
    throw err;
  }
}

const dotenvModule = await loadModule('dotenv', 'dotenv/lib/main.js');
const { config } = dotenvModule;

const envPaths = [
  join(projectRoot, '.env'),
  join(__dirname, '.env'),
  '/app/.env',
];
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath });
    break;
  }
}

const mongooseModule = await loadModule('mongoose', 'mongoose/index.js');
const mongoose = mongooseModule.default ?? mongooseModule;

const argon2Module = await loadModule('@node-rs/argon2', '@node-rs/argon2/index.js');
const { hash, Algorithm, Version } = argon2Module;

function usage() {
  console.log('Usage: ./scripts/changeuserpwd.sh --email user@example.com [--newpasswd 123456] [--allow-email-login true|false]');
}

function parseArgs(argv) {
  let email = '';
  let newPassword = null;
  let allowEmailLogin;
  let newPasswordProvided = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') {
      email = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--newpasswd') {
      const supplied = argv[i + 1];
      if (supplied !== undefined) {
        newPassword = String(supplied);
        newPasswordProvided = true;
      }
      i += 1;
      continue;
    }
    if (arg === '--allow-email-login') {
      const supplied = String(argv[i + 1] || '').trim().toLowerCase();
      if (supplied !== 'true' && supplied !== 'false') {
        console.error('--allow-email-login must be true or false.');
        process.exit(1);
      }
      allowEmailLogin = supplied === 'true';
      i += 1;
      continue;
    }
    if (arg === '--enable-email-login') {
      allowEmailLogin = true;
      continue;
    }
    if (arg === '--disable-email-login') {
      allowEmailLogin = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }

    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(1);
  }

  if (!email) {
    console.error('--email is required.');
    usage();
    process.exit(1);
  }

  if (!newPasswordProvided && allowEmailLogin === undefined) {
    newPassword = '123456';
  }

  if (newPassword !== null && (!newPassword || newPassword.length < 6)) {
    console.error('--newpasswd must be at least 6 characters.');
    process.exit(1);
  }

  return { email, newPassword, allowEmailLogin };
}

function emailRegex(email) {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
}

async function hashPasswordArgon2id(password) {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    version: Version.V0x13,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
}

async function main() {
  const { email, newPassword, allowEmailLogin } = parseArgs(process.argv.slice(2));
  const MONGO_URI = process.env.MONGO_URI
    || (process.env.MONGO_PORT ? `mongodb://localhost:${process.env.MONGO_PORT}/qlicker` : '');

  if (!MONGO_URI) {
    console.error('MONGO_URI or MONGO_PORT must be set in .env');
    process.exit(1);
  }

  console.log(`Connecting to MongoDB: ${MONGO_URI}`);
  await mongoose.connect(MONGO_URI);

  try {
    const usersCollection = mongoose.connection.collection('users');
    const user = await usersCollection.findOne({ 'emails.address': emailRegex(email) });

    if (!user) {
      console.error(`User not found for email: ${email}`);
      process.exitCode = 1;
      return;
    }

    const setUpdates = {};
    const unsetUpdates = {};

    if (newPassword !== null) {
      const hashedPassword = await hashPasswordArgon2id(newPassword);
      setUpdates['services.password.hash'] = hashedPassword;
      unsetUpdates['services.password.bcrypt'] = '';
      unsetUpdates['services.resetPassword'] = '';
      console.log(`Password will be updated for ${email}`);
    }

    if (allowEmailLogin !== undefined) {
      const isAdmin = Array.isArray(user.profile?.roles) && user.profile.roles.includes('admin');
      setUpdates.allowEmailLogin = isAdmin ? true : allowEmailLogin;
      if (allowEmailLogin === false || isAdmin) {
        unsetUpdates['services.resetPassword'] = '';
      }
      console.log(`allowEmailLogin will be set to ${setUpdates.allowEmailLogin} for ${email}`);
    }

    const updateDoc = {};
    if (Object.keys(setUpdates).length > 0) updateDoc.$set = setUpdates;
    if (Object.keys(unsetUpdates).length > 0) updateDoc.$unset = unsetUpdates;

    const updateResult = await usersCollection.updateOne({ _id: user._id }, updateDoc);

    if (!updateResult.matchedCount) {
      console.error(`Failed to update user for email: ${email}`);
      process.exitCode = 1;
      return;
    }

    console.log(`User updated for ${email}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Failed to change password:', err);
  process.exit(1);
});
