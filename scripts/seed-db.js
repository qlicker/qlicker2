#!/usr/bin/env node

import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

async function loadModule(moduleName, fallbackRelativePath) {
  try {
    return await import(moduleName);
  } catch (err) {
    // Local script execution may not have a root package.json/node_modules.
    // Fall back to server dependencies when present.
    const fallbackPath = join(projectRoot, 'server', 'node_modules', fallbackRelativePath);
    if (existsSync(fallbackPath)) {
      return import(pathToFileURL(fallbackPath).href);
    }
    throw err;
  }
}

const mongooseModule = await loadModule('mongoose', 'mongoose/index.js');
const mongoose = mongooseModule.default ?? mongooseModule;

const dotenvModule = await loadModule('dotenv', 'dotenv/lib/main.js');
const { config } = dotenvModule;

async function loadArgon2Module() {
  return loadModule('@node-rs/argon2', '@node-rs/argon2/index.js');
}

const { hash, Algorithm, Version } = await loadArgon2Module();

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

// Try loading .env from project root, then from parent (for Docker)
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

const MONGO_URI = process.env.MONGO_URI
  || (process.env.MONGO_PORT ? `mongodb://localhost:${process.env.MONGO_PORT}/qlicker` : '');

if (!MONGO_URI) {
  console.error('MONGO_URI or MONGO_PORT must be set in .env');
  process.exit(1);
}
const args = process.argv.slice(2);
const shouldReset = args.includes('--reset') || args.includes('--reset-only');

// Inline User schema to avoid path resolution issues in Docker
const EmailSchema = new mongoose.Schema(
  { address: { type: String, required: true }, verified: { type: Boolean, default: false } },
  { _id: false }
);

const PasswordSchema = new mongoose.Schema(
  {
    hash: { type: String },
    bcrypt: { type: String },
  },
  { _id: false }
);
const ResumeSchema = new mongoose.Schema({ loginTokens: { type: Array, default: [] } }, { _id: false });
const EmailTokenSchema = new mongoose.Schema(
  { token: { type: String }, address: { type: String }, when: { type: Date } },
  { _id: false }
);
const EmailServiceSchema = new mongoose.Schema(
  { verificationTokens: { type: [EmailTokenSchema], default: [] } },
  { _id: false }
);
const ResetPasswordSchema = new mongoose.Schema(
  { token: { type: String }, email: { type: String }, when: { type: Date }, reason: { type: String, default: 'reset' } },
  { _id: false }
);
const ServicesSchema = new mongoose.Schema(
  {
    password: { type: PasswordSchema, default: () => ({}) },
    resume: { type: ResumeSchema, default: () => ({}) },
    email: { type: EmailServiceSchema, default: () => ({}) },
    resetPassword: { type: ResetPasswordSchema },
  },
  { _id: false }
);
const ProfileSchema = new mongoose.Schema(
  {
    firstname: { type: String, default: '' },
    lastname: { type: String, default: '' },
    roles: { type: [String], default: ['student'] },
    courses: { type: Array, default: [] },
    studentNumber: { type: String, default: '' },
    profileImage: { type: String, default: '' },
    profileThumbnail: { type: String, default: '' },
    canPromote: { type: Boolean, default: false },
  },
  { _id: false }
);

function generateMeteorId() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz';
  let result = '';
  const bytes = new Uint8Array(17);
  crypto.randomFillSync(bytes);
  for (let i = 0; i < 17; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

const UserSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    emails: { type: [EmailSchema], default: [] },
    services: { type: ServicesSchema, default: () => ({}) },
    profile: { type: ProfileSchema, default: () => ({}) },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'users', timestamps: false }
);

const User = mongoose.models.User || mongoose.model('User', UserSchema);

async function main() {
  console.log(`Connecting to MongoDB: ${MONGO_URI}`);
  await mongoose.connect(MONGO_URI);
  console.log('Connected.');

  if (shouldReset) {
    console.log('Resetting database — dropping database...');
    await mongoose.connection.db.dropDatabase();
    console.log('Database dropped.');
    console.log('Reset complete. Database is empty.');
    await mongoose.disconnect();
    return;
  }

  console.log('Seeding users...');

  const users = [
    {
      email: 'admin@qlicker.com',
      password: 'admin123',
      firstname: 'Admin',
      lastname: 'User',
      roles: ['admin'],
    },
    {
      email: 'prof@qlicker.com',
      password: 'prof123',
      firstname: 'Professor',
      lastname: 'User',
      roles: ['professor'],
    },
    {
      email: 'student@qlicker.com',
      password: 'student123',
      firstname: 'Student',
      lastname: 'User',
      roles: ['student'],
    },
  ];

  for (const u of users) {
    const existing = await User.findOne({ 'emails.address': u.email });
    if (existing) {
      console.log(`  [SKIP] ${u.email} already exists`);
      continue;
    }

    const hashedPassword = await hashPasswordArgon2id(u.password);

    const user = new User({
      emails: [{ address: u.email, verified: true }],
      services: {
        password: { hash: hashedPassword },
      },
      profile: {
        firstname: u.firstname,
        lastname: u.lastname,
        roles: u.roles,
      },
    });

    await user.save();
    console.log(`  [OK] Created ${u.email} (${u.roles.join(', ')})`);
  }

  console.log('');
  console.log('Seed complete!');
  console.log('');
  console.log('  admin@qlicker.com   / admin123    (admin)');
  console.log('  prof@qlicker.com    / prof123     (professor)');
  console.log('  student@qlicker.com / student123  (student)');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
