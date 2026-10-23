#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SANITIZE_S3=false

run_settings_reconcile_in_server_container() {
  local script_path="/app/scripts/reconcile-settings-singleton.js"
  if docker exec "$SERVER_CONTAINER" test -f "$script_path"; then
    docker exec "$SERVER_CONTAINER" node "$script_path"
    return
  fi

  echo "Server image does not include $script_path. Running inline reconciliation fallback..."
  docker exec -i "$SERVER_CONTAINER" node --input-type=module - <<'EOF'
import mongoose from 'mongoose';
import Settings from './src/models/Settings.js';
import { ensureSettingsSingleton } from './src/utils/settingsSingleton.js';

const mongoUri = process.env.MONGO_URI || 'mongodb://mongo:27017/qlicker';
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
}

await mongoose.disconnect();
EOF
}

run_question_type_migration_in_server_container() {
  local mode="${1:-dry-run}"
  local script_path="/app/scripts/migrate-question-types.js"
  if docker exec "$SERVER_CONTAINER" test -f "$script_path"; then
    if [ "$mode" = "apply" ]; then
      docker exec "$SERVER_CONTAINER" node "$script_path" --apply
    else
      docker exec "$SERVER_CONTAINER" node "$script_path"
    fi
    return
  fi

  echo "Server image does not include $script_path. Running inline question-type migration fallback ($mode)..."
  docker exec -i "$SERVER_CONTAINER" node --input-type=module - "$mode" <<'EOF'
import mongoose from 'mongoose';
import Question from './src/models/Question.js';

const QUESTION_TYPES = {
  MULTIPLE_CHOICE: 0,
  TRUE_FALSE: 1,
  SHORT_ANSWER: 2,
  MULTI_SELECT: 3,
  NUMERICAL: 4,
};
const CANONICAL_TYPES = new Set(Object.values(QUESTION_TYPES));

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

const mode = process.argv[2] || 'dry-run';
const apply = mode === 'apply';
const mongoUri = process.env.MONGO_URI || 'mongodb://mongo:27017/qlicker';

console.log(`Question type migration mode: ${apply ? 'APPLY' : 'DRY-RUN'} (inline fallback)`);
await mongoose.connect(mongoUri);

const stats = { scanned: 0, alreadyCanonical: 0, updated: 0 };
const ops = [];

const cursor = Question.find(
  {},
  { _id: 1, type: 1, options: 1, correctNumerical: 1, toleranceNumerical: 1 }
).lean().cursor();

for await (const question of cursor) {
  stats.scanned += 1;
  const oldType = Number(question.type);
  const { nextType } = resolveType(question);
  if (oldType === nextType) {
    stats.alreadyCanonical += 1;
    continue;
  }
  stats.updated += 1;
  if (apply) {
    ops.push({
      updateOne: {
        filter: { _id: question._id },
        update: { $set: { type: nextType } },
      },
    });
  }
}

if (apply && ops.length > 0) {
  const chunkSize = 1000;
  for (let i = 0; i < ops.length; i += chunkSize) {
    await Question.bulkWrite(ops.slice(i, i + chunkSize), { ordered: false });
  }
}

console.log('\nSummary');
console.log(`  scanned: ${stats.scanned}`);
console.log(`  already canonical: ${stats.alreadyCanonical}`);
console.log(`  to update: ${stats.updated}`);
if (apply) {
  console.log(`  updates applied: ${ops.length}`);
}

await mongoose.disconnect();
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --sanitize-s3)
      SANITIZE_S3=true
      shift
      ;;
    --help|-h)
      echo "Usage: ./scripts/init-from-legacy-docker.sh [--sanitize-s3]"
      echo "  Restores a legacy dump into the Docker dev database, then applies"
      echo "  the question-type migration inside the server container."
      echo "  --sanitize-s3   Also rewrite legacy S3 URLs to /uploads/... and run the ACL pass"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

echo "Restoring legacy dump into Docker dev database..."
"$SCRIPT_DIR/seed-db-docker.sh" --legacy-restore

SERVER_CONTAINER="$(docker compose ps -q server 2>/dev/null | head -1)"
if [ -z "$SERVER_CONTAINER" ]; then
  echo "Server container is not running. Start with: docker compose up -d server"
  exit 1
fi

echo "Reconciling settings singleton inside server container..."
run_settings_reconcile_in_server_container

echo "Applying question-type migration inside server container..."
run_question_type_migration_in_server_container "apply"

if [ "$SANITIZE_S3" = true ]; then
  echo "Running S3 sanitization inside server container..."
  docker exec -i "$SERVER_CONTAINER" node --input-type=module - --apply < "$PROJECT_ROOT/production_setup/sanitize-s3.js"
fi

echo "Legacy initialization complete."
