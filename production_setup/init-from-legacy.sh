#!/usr/bin/env bash
# =============================================================================
# Qlicker Production — Initialize from Legacy Database
# =============================================================================
# Restores a mongodump from the legacy MeteorJS Qlicker instance,
# runs the question-type migration, and optionally sanitizes S3 uploads
# for private-bucket mode.
#
# Prerequisites:
#   - Place your legacy mongodump directory under ./legacydb/
#     e.g., ./legacydb/<dump_name>/<db_name>/ containing .bson and .metadata.json files
#   - Docker Compose services must be running (at least mongo and server)
#
# Usage:
#   ./init-from-legacy.sh                    # Interactive
#   ./init-from-legacy.sh --dump-dir ./legacydb/<dump_name>  # Specify dump root
#   ./init-from-legacy.sh --sanitize-s3      # Also rewrite DB image refs + privatize S3 objects
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
LEGACY_DIR="$SCRIPT_DIR/legacydb"
DUMP_DIR=""
SANITIZE_S3=false

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }

run_settings_reconcile_in_server_container() {
  local script_path="/app/scripts/reconcile-settings-singleton.js"
  if docker exec "$SERVER_CONTAINER" test -f "$script_path"; then
    docker exec "$SERVER_CONTAINER" node "$script_path"
    return
  fi

  warn "Server image does not include $script_path. Running inline reconciliation fallback."
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
  console.log(`  AWS_bucket: ${canonical.AWS_bucket ? '[set]' : '[empty]'}`);
  console.log(`  Azure_storageAccount: ${canonical.Azure_storageAccount || canonical.Azure_accountName ? '[set]' : '[empty]'}`);
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

  warn "Server image does not include $script_path. Running inline question-type migration fallback (${mode})."
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

const stats = {
  scanned: 0,
  alreadyCanonical: 0,
  updated: 0,
  byReason: {},
  byTransition: {},
};
const ops = [];

const cursor = Question.find(
  {},
  { _id: 1, type: 1, options: 1, correctNumerical: 1, toleranceNumerical: 1 }
).lean().cursor();

for await (const question of cursor) {
  stats.scanned += 1;
  const oldType = Number(question.type);
  const { nextType, reason } = resolveType(question);

  if (oldType === nextType) {
    stats.alreadyCanonical += 1;
    continue;
  }

  stats.updated += 1;
  const transitionKey = `${String(question.type)} -> ${nextType}`;
  stats.byTransition[transitionKey] = (stats.byTransition[transitionKey] || 0) + 1;
  stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;

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

console.log('\nTransitions');
for (const [key, count] of Object.entries(stats.byTransition).sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${key}: ${count}`);
}
if (Object.keys(stats.byTransition).length === 0) {
  console.log('  (none)');
}

await mongoose.disconnect();
EOF
}

is_system_database_name() {
  case "$1" in
    admin|local|config) return 0 ;;
    *) return 1 ;;
  esac
}

pick_primary_app_database() {
  local db_name
  for db_name in "$@"; do
    if ! is_system_database_name "$db_name"; then
      printf '%s\n' "$db_name"
      return 0
    fi
  done
  if [ "$#" -gt 0 ]; then
    printf '%s\n' "$1"
    return 0
  fi
  return 1
}

dir_has_bson_files() {
  local dir="$1"
  find "$dir" -maxdepth 1 -type f -name '*.bson' ! -name 'oplog.bson' -print -quit | grep -q .
}

list_dump_databases() {
  local dump_root="$1"
  find "$dump_root" -mindepth 1 -maxdepth 1 -type d \
    | while IFS= read -r db_dir; do
        if dir_has_bson_files "$db_dir"; then
          basename "$db_dir"
        fi
      done \
    | sort -u
}

find_legacy_candidates() {
  if [ ! -d "$LEGACY_DIR" ]; then
    return 0
  fi

  find "$LEGACY_DIR" -type f -name '*.bson' ! -name 'oplog.bson' \
    | while IFS= read -r file; do
        local rel top
        rel="${file#$LEGACY_DIR/}"
        top="${rel%%/*}"
        if [ "$top" != "$rel" ]; then
          printf '%s\n' "$LEGACY_DIR/$top"
        fi
      done \
    | sort -u
}

db_name_from_uri() {
  local uri="$1"
  local no_query db_name
  no_query="${uri%%\?*}"
  db_name="${no_query##*/}"
  if [ -z "$db_name" ] || [ "$db_name" = "$no_query" ]; then
    db_name="qlicker"
  fi
  printf '%s\n' "$db_name"
}

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --dump-dir)
      if [ $# -lt 2 ]; then
        error "--dump-dir requires a path argument"
        exit 1
      fi
      DUMP_DIR="$2"
      shift 2
      ;;
    --sanitize-s3) SANITIZE_S3=true; shift ;;
    --help|-h)
      echo "Usage: ./init-from-legacy.sh [--dump-dir DIR] [--sanitize-s3]"
      echo "  --dump-dir DIR    Path to mongodump directory"
      echo "  --sanitize-s3     Rewrite DB image refs and run S3 privatization after restore"
      exit 0
      ;;
    *) error "Unknown argument: $1"; exit 1 ;;
  esac
done

# Load .env
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; . "$SCRIPT_DIR/.env"; set +a
else
  error ".env file not found. Run ./setup.sh first."
  exit 1
fi

# ---- Find legacy dump -------------------------------------------------------
if [ -z "$DUMP_DIR" ]; then
  mkdir -p "$LEGACY_DIR"

  mapfile -t CANDIDATES < <(find_legacy_candidates)

  if [ "${#CANDIDATES[@]}" -eq 0 ]; then
    error "No dump directories found in $LEGACY_DIR/"
    echo ""
    echo "Place your mongodump output directory here:"
    echo "  $LEGACY_DIR/<dump_name>/<database_name>/"
    echo ""
    echo "The database directories should contain .bson and .metadata.json files."
    echo "You can create a dump with:"
    echo "  mongodump --uri='mongodb://host:port/qlicker' --out='$LEGACY_DIR'"
    exit 1
  fi

  if [ "${#CANDIDATES[@]}" -eq 1 ]; then
    DUMP_DIR="${CANDIDATES[0]}"
    info "Using dump: $(basename "$DUMP_DIR")"
  else
    echo "Found legacy dump directories:"
    for i in "${!CANDIDATES[@]}"; do
      echo "  $((i + 1))) $(basename "${CANDIDATES[$i]}")"
    done
    while true; do
      read -r -p "Choose [1-${#CANDIDATES[@]}]: " choice
      if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#CANDIDATES[@]}" ]; then
        DUMP_DIR="${CANDIDATES[$((choice - 1))]}"
        break
      fi
      echo "Invalid choice."
    done
  fi
fi

if [ ! -d "$DUMP_DIR" ]; then
  error "Dump directory not found: $DUMP_DIR"
  exit 1
fi

DUMP_DIR="$(cd "$DUMP_DIR" && pwd)"
DUMP_NAME="$(basename "$DUMP_DIR")"
TARGET_DB="$(db_name_from_uri "${MONGO_URI:-mongodb://localhost:27017/qlicker}")"

SOURCE_DB_NAMES=()
SOURCE_DB_DIRS=()

if dir_has_bson_files "$DUMP_DIR"; then
  # Accept --dump-dir pointing directly at a single database dump directory.
  SOURCE_DB_NAMES+=("$(basename "$DUMP_DIR")")
  SOURCE_DB_DIRS+=("$DUMP_DIR")
else
  mapfile -t SOURCE_DB_NAMES < <(list_dump_databases "$DUMP_DIR")
  if [ "${#SOURCE_DB_NAMES[@]}" -eq 0 ]; then
    error "No database dump directories with .bson files found in $DUMP_DIR"
    exit 1
  fi
  for db_name in "${SOURCE_DB_NAMES[@]}"; do
    SOURCE_DB_DIRS+=("$DUMP_DIR/$db_name")
  done
fi

if ! PRIMARY_SOURCE_DB="$(pick_primary_app_database "${SOURCE_DB_NAMES[@]}")"; then
  error "Unable to determine primary application database in $DUMP_DIR"
  exit 1
fi

# ---- Get containers ----------------------------------------------------------
MONGO_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q mongo 2>/dev/null | head -1)"
SERVER_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q server 2>/dev/null | head -1)"

if [ -z "$MONGO_CONTAINER" ]; then
  error "MongoDB container is not running. Start with: docker compose up -d"
  exit 1
fi
if [ -z "$SERVER_CONTAINER" ]; then
  error "Server container is not running. Start with: docker compose up -d"
  exit 1
fi

# ---- Confirmation ------------------------------------------------------------
echo ""
echo "======================================"
echo "  Initialize from Legacy Database"
echo "======================================"
echo ""
echo "  Source dump:   $DUMP_NAME"
echo "  Dump DBs:      ${SOURCE_DB_NAMES[*]}"
echo "  Primary DB:    $PRIMARY_SOURCE_DB"
echo "  Target DB:     $TARGET_DB"
echo ""
warn "This will DROP and replace data in '$TARGET_DB' (and any restored system DBs)."
echo ""
read -r -p "Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Cancelled."
  exit 0
fi

# ---- Create pre-init backup if data exists -----------------------------------
COLLECTION_COUNT="$(docker exec "$MONGO_CONTAINER" mongosh "$MONGO_URI" --quiet --eval 'db.getCollectionNames().length' 2>/dev/null || echo 0)"
if [ "$COLLECTION_COUNT" -gt 0 ]; then
  info "Creating backup of existing data before restore..."
  "$SCRIPT_DIR/backup.sh" || warn "Backup failed, continuing anyway."
fi

# ---- Restore legacy dump -----------------------------------------------------
CONTAINER_TEMP="/tmp/legacy-restore-$$"
cleanup_restore_temp() {
  docker exec "$MONGO_CONTAINER" rm -rf "$CONTAINER_TEMP" 2>/dev/null || true
}
trap cleanup_restore_temp EXIT

info "Copying dump into mongo container..."
docker exec "$MONGO_CONTAINER" mkdir -p "$CONTAINER_TEMP"
for i in "${!SOURCE_DB_NAMES[@]}"; do
  source_db="${SOURCE_DB_NAMES[$i]}"
  source_dir="${SOURCE_DB_DIRS[$i]}"
  docker exec "$MONGO_CONTAINER" mkdir -p "$CONTAINER_TEMP/$source_db"
  docker cp "$source_dir/." "$MONGO_CONTAINER:$CONTAINER_TEMP/$source_db/"
done

info "Running mongorestore (--drop) per database..."
for source_db in "${SOURCE_DB_NAMES[@]}"; do
  restore_db="$source_db"
  if [ "$source_db" = "$PRIMARY_SOURCE_DB" ]; then
    restore_db="$TARGET_DB"
  fi
  info "Restoring '$source_db' -> '$restore_db'..."
  docker exec "$MONGO_CONTAINER" mongorestore \
    --uri="$MONGO_URI" \
    --db="$restore_db" \
    --drop \
    "$CONTAINER_TEMP/$source_db"
done
info "mongorestore complete."

docker exec "$MONGO_CONTAINER" rm -rf "$CONTAINER_TEMP" 2>/dev/null || true
trap - EXIT

# ---- Reconcile settings singleton --------------------------------------------
info "Reconciling settings singleton (defaults + legacy overrides)..."
run_settings_reconcile_in_server_container

# ---- Run question-type migration ---------------------------------------------
info "Running question-type migration (dry run)..."
run_question_type_migration_in_server_container "dry-run" 2>&1 | tail -5

echo ""
read -r -p "Apply question-type migration? [Y/n]: " APPLY_MIGRATION
if [[ "${APPLY_MIGRATION:-Y}" =~ ^[Yy] ]]; then
  info "Applying migration..."
  run_question_type_migration_in_server_container "apply"
  info "Migration applied."
else
  warn "Migration skipped. Run manually later:"
  echo "  ./init-from-legacy.sh"
fi

# ---- Sanitize S3 (optional) -------------------------------------------------
if [ "$SANITIZE_S3" = true ]; then
  if [ -x "$SCRIPT_DIR/sanitize-s3.sh" ]; then
    info "Running S3 sanitization (DB rewrite + ACL pass)..."
    "$SCRIPT_DIR/sanitize-s3.sh" --apply
    info "S3 sanitization complete."
  else
    warn "sanitize-s3.sh is missing or not executable. Skipping S3 sanitization."
  fi
fi

# ---- Done -------------------------------------------------------------------
echo ""
echo "======================================"
echo "  Legacy initialization complete!"
echo "======================================"
echo ""
echo "  Next steps:"
echo "    1. Verify the app: https://${DOMAIN:-localhost}"
echo "    2. Change the admin password:"
echo "       ./manage-user.sh change-password --email admin@example.com"
echo "    3. Create a backup: ./backup.sh"
echo "    4. If legacy images still point at public S3 URLs, run:"
echo "       ./sanitize-s3.sh"
echo "       ./sanitize-s3.sh --apply"
echo ""
