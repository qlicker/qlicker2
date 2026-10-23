#!/usr/bin/env node

import mongoose from 'mongoose';
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Question from '../src/models/Question.js';

const QUESTION_TYPES = {
  MULTIPLE_CHOICE: 0,
  TRUE_FALSE: 1,
  SHORT_ANSWER: 2,
  MULTI_SELECT: 3,
  NUMERICAL: 4,
};

const CANONICAL_TYPES = new Set(Object.values(QUESTION_TYPES));

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
    console.log('Usage: node server/scripts/migrate-question-types.js [--apply]');
    console.log('  Default mode: dry-run (reports only, no writes)');
    console.log('  --apply: execute updates');
    process.exit(0);
  }

  return {
    apply: args.has('--apply'),
  };
}

function numericValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function countCorrect(options = []) {
  return options.reduce((acc, option) => (option?.correct ? acc + 1 : acc), 0);
}

function stripHtml(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function isTrueFalseOptions(options = []) {
  if (!Array.isArray(options) || options.length !== 2) return false;
  const labels = options
    .map((option) => stripHtml(option?.answer || option?.plainText || option?.content || '').toUpperCase())
    .filter(Boolean);
  return labels.includes('TRUE') && labels.includes('FALSE');
}

function inferTypeForInvalidValue(question) {
  const options = Array.isArray(question.options) ? question.options : [];

  if (options.length > 1) {
    if (isTrueFalseOptions(options)) {
      return { nextType: QUESTION_TYPES.TRUE_FALSE, reason: 'invalid_type_inferred_true_false' };
    }
    const correctCount = countCorrect(options);
    if (correctCount > 1) {
      return { nextType: QUESTION_TYPES.MULTI_SELECT, reason: 'invalid_type_inferred_multi_select' };
    }
    return { nextType: QUESTION_TYPES.MULTIPLE_CHOICE, reason: 'invalid_type_inferred_multiple_choice' };
  }

  const correctNumerical = numericValue(question.correctNumerical);
  const toleranceNumerical = numericValue(question.toleranceNumerical);
  const hasMeaningfulNumerical = (correctNumerical !== null && correctNumerical !== 0)
    || (toleranceNumerical !== null && toleranceNumerical !== 0);

  if (hasMeaningfulNumerical && options.length === 0) {
    return { nextType: QUESTION_TYPES.NUMERICAL, reason: 'invalid_type_inferred_numerical' };
  }

  return { nextType: QUESTION_TYPES.SHORT_ANSWER, reason: 'invalid_type_default_short_answer' };
}

function resolveType(question) {
  const rawType = Number(question.type);
  const options = Array.isArray(question.options) ? question.options : [];

  if (rawType === QUESTION_TYPES.NUMERICAL && options.length > 1) {
    // Legacy outlier: numerical type cannot have multiple choices.
    // Normalize to the appropriate option-based type once.
    if (isTrueFalseOptions(options)) {
      return { nextType: QUESTION_TYPES.TRUE_FALSE, reason: 'numerical_with_options_to_true_false' };
    }
    const correctCount = countCorrect(options);
    return {
      nextType: correctCount > 1 ? QUESTION_TYPES.MULTI_SELECT : QUESTION_TYPES.MULTIPLE_CHOICE,
      reason: correctCount > 1 ? 'numerical_with_options_to_multi_select' : 'numerical_with_options_to_multiple_choice',
    };
  }

  if (CANONICAL_TYPES.has(rawType)) {
    return { nextType: rawType, reason: null };
  }

  if (rawType === 5) {
    return { nextType: QUESTION_TYPES.NUMERICAL, reason: 'legacy_type_5_to_numerical' };
  }

  return inferTypeForInvalidValue(question);
}

async function main() {
  const envPath = loadEnvironment();
  const { apply } = parseArgs(process.argv);

  const mongoUri = process.env.MONGO_URI
    || (process.env.MONGO_PORT ? `mongodb://localhost:${process.env.MONGO_PORT}/qlicker` : '');

  if (!mongoUri) {
    console.error('MONGO_URI or MONGO_PORT must be set.');
    process.exit(1);
  }

  console.log(`Question type migration mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Mongo URI: ${mongoUri}`);
  console.log(`Env file: ${envPath || 'not found (using process env only)'}`);

  await mongoose.connect(mongoUri);

  const stats = {
    scanned: 0,
    alreadyCanonical: 0,
    updated: 0,
    byReason: {},
    byTransition: {},
    samples: [],
  };

  const ops = [];
  const cursor = Question.find(
    {},
    { _id: 1, type: 1, options: 1, correctNumerical: 1, toleranceNumerical: 1 }
  )
    .lean()
    .cursor();

  for await (const question of cursor) {
    stats.scanned += 1;

    const oldType = Number(question.type);
    const { nextType, reason } = resolveType(question);

    if (oldType === nextType) {
      stats.alreadyCanonical += 1;
      continue;
    }

    stats.updated += 1;
    stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;

    const transitionKey = `${String(question.type)} -> ${nextType}`;
    stats.byTransition[transitionKey] = (stats.byTransition[transitionKey] || 0) + 1;

    if (stats.samples.length < 20) {
      stats.samples.push({
        _id: question._id,
        from: question.type,
        to: nextType,
        reason,
        optionsCount: Array.isArray(question.options) ? question.options.length : 0,
      });
    }

    if (apply) {
      ops.push({
        updateOne: {
          filter: { _id: question._id },
          update: { $set: { type: nextType } },
        },
      });
    }
  }

  console.log('\nSummary');
  console.log(`  scanned: ${stats.scanned}`);
  console.log(`  already canonical: ${stats.alreadyCanonical}`);
  console.log(`  to update: ${stats.updated}`);

  console.log('\nTransitions');
  if (Object.keys(stats.byTransition).length === 0) {
    console.log('  (none)');
  } else {
    Object.entries(stats.byTransition)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([key, count]) => console.log(`  ${key}: ${count}`));
  }

  console.log('\nReasons');
  if (Object.keys(stats.byReason).length === 0) {
    console.log('  (none)');
  } else {
    Object.entries(stats.byReason)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([key, count]) => console.log(`  ${key}: ${count}`));
  }

  console.log('\nSample changes');
  if (stats.samples.length === 0) {
    console.log('  (none)');
  } else {
    stats.samples.forEach((sample) => {
      console.log(`  ${sample._id}: ${sample.from} -> ${sample.to} (${sample.reason}, options=${sample.optionsCount})`);
    });
  }

  if (apply && ops.length > 0) {
    console.log('\nApplying updates...');
    const chunkSize = 1000;
    for (let i = 0; i < ops.length; i += chunkSize) {
      const chunk = ops.slice(i, i + chunkSize);
      // ordered:false continues applying the batch if one update fails.
      // This is safer for one-time cleanup over large legacy datasets.
      await Question.bulkWrite(chunk, { ordered: false });
    }
    console.log(`Applied ${ops.length} updates.`);
  } else if (apply) {
    console.log('\nNo updates needed.');
  } else {
    console.log('\nDry-run complete. Re-run with --apply to write changes.');
  }

  const distribution = await Question.aggregate([
    { $group: { _id: '$type', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  console.log('\nType distribution');
  distribution.forEach((row) => console.log(`  type=${row._id}: ${row.count}`));

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Question type migration failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect errors in failure path
  }
  process.exit(1);
});
