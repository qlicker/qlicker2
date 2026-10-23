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
const mongooseModule = await loadModule('mongoose', 'mongoose/index.js');
const { config } = dotenvModule;
const mongoose = mongooseModule.default ?? mongooseModule;

function usage() {
  console.log('Usage: node scripts/dedupe-grades.js [--apply] [--mongo-uri <uri>] [--skip-index] [--verbose]');
  console.log('  default mode is dry-run; add --apply to perform deletions');
}

function parseArgs(argv) {
  let mongoUriArg = '';
  let apply = false;
  let skipIndex = false;
  let verbose = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--skip-index') {
      skipIndex = true;
      continue;
    }
    if (arg === '--verbose') {
      verbose = true;
      continue;
    }
    if (arg === '--mongo-uri') {
      mongoUriArg = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }

    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(1);
  }

  return {
    apply,
    skipIndex,
    verbose,
    mongoUriArg,
  };
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function scoreGradeDoc(doc) {
  const manualBonus = doc?.automatic === false ? 1_000_000 : 0;
  const needsGradingBonus = doc?.needsGrading ? 10_000 : 0;
  const answeredWeight = toFiniteNumber(doc?.numAnsweredTotal, 0) * 100;
  const marksWeight = (Array.isArray(doc?.marks) ? doc.marks.length : 0) * 10;
  const outOfWeight = toFiniteNumber(doc?.outOf, 0);
  return manualBonus + needsGradingBonus + answeredWeight + marksWeight + outOfWeight;
}

function pickCanonicalGrade(docs = []) {
  if (!Array.isArray(docs) || docs.length === 0) return null;
  return [...docs].sort((a, b) => {
    const scoreDiff = scoreGradeDoc(b) - scoreGradeDoc(a);
    if (scoreDiff !== 0) return scoreDiff;
    return String(b?._id || '').localeCompare(String(a?._id || ''));
  })[0];
}

function loadEnvIfPresent() {
  const envPaths = [
    join(projectRoot, '.env'),
    join(__dirname, '.env'),
    '/app/.env',
  ];

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;
    config({ path: envPath });
    return envPath;
  }

  return null;
}

async function main() {
  const {
    apply,
    skipIndex,
    verbose,
    mongoUriArg,
  } = parseArgs(process.argv.slice(2));

  const loadedEnvPath = loadEnvIfPresent();
  if (loadedEnvPath && verbose) {
    console.log(`Loaded environment from: ${loadedEnvPath}`);
  }

  const mongoUri = mongoUriArg
    || process.env.MONGO_URI
    || (process.env.MONGO_PORT ? `mongodb://localhost:${process.env.MONGO_PORT}/qlicker` : '');

  if (!mongoUri) {
    console.error('MONGO_URI or MONGO_PORT must be set (or pass --mongo-uri).');
    process.exit(1);
  }

  console.log(`Connecting to MongoDB: ${mongoUri}`);
  await mongoose.connect(mongoUri);

  const gradesCollection = mongoose.connection.collection('grades');
  let duplicateIdentityCount = 0;
  let duplicateRowCount = 0;
  let deletedRowCount = 0;

  try {
    const duplicateGroups = await gradesCollection.aggregate([
      {
        $group: {
          _id: {
            courseId: '$courseId',
            sessionId: '$sessionId',
            userId: '$userId',
          },
          ids: { $push: '$_id' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();

    duplicateIdentityCount = duplicateGroups.length;
    duplicateRowCount = duplicateGroups.reduce((sum, group) => sum + Math.max(0, Number(group?.count || 0) - 1), 0);

    if (duplicateIdentityCount === 0) {
      console.log('No duplicate grade identities found.');
    } else {
      console.log(`Found ${duplicateIdentityCount} duplicate identities (${duplicateRowCount} extra rows).`);
    }

    if (duplicateIdentityCount > 0) {
      const deleteOps = [];

      for (const group of duplicateGroups) {
        const rawIds = Array.isArray(group?.ids) ? group.ids : [];
        if (rawIds.length < 2) continue;

        const groupDocs = await gradesCollection.find({ _id: { $in: rawIds } }).toArray();
        const canonical = pickCanonicalGrade(groupDocs);
        const canonicalId = String(canonical?._id || '');
        const removeIds = groupDocs
          .map((doc) => String(doc?._id || ''))
          .filter((id) => id && id !== canonicalId);

        if (verbose) {
          console.log(`identity course=${group?._id?.courseId} session=${group?._id?.sessionId} user=${group?._id?.userId}`);
          console.log(`  keep: ${canonicalId}`);
          console.log(`  drop: ${removeIds.join(', ')}`);
        }

        if (apply && removeIds.length > 0) {
          deleteOps.push({
            deleteMany: {
              filter: { _id: { $in: removeIds } },
            },
          });
        }
      }

      if (apply && deleteOps.length > 0) {
        const bulkResult = await gradesCollection.bulkWrite(deleteOps, { ordered: false });
        deletedRowCount = Number(bulkResult?.deletedCount || 0);
      }
    }

    if (apply && !skipIndex) {
      console.log('Ensuring unique index: grade_identity_unique');
      await gradesCollection.createIndex(
        { courseId: 1, sessionId: 1, userId: 1 },
        { unique: true, name: 'grade_identity_unique' }
      );
    }

    if (!apply) {
      console.log('Dry run complete. Re-run with --apply to delete duplicates.');
    } else {
      console.log(`Deleted duplicate rows: ${deletedRowCount}`);
      if (skipIndex) {
        console.log('Skipped unique index creation (--skip-index).');
      } else {
        console.log('Unique index ensured: grade_identity_unique');
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Failed to dedupe grades:', err);
  process.exit(1);
});
