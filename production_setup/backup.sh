#!/usr/bin/env sh
# =============================================================================
# Qlicker Production — MongoDB Backup Script
# =============================================================================
# Creates a timestamped mongodump of the Qlicker database.
# Backups are stored in BACKUP_HOST_PATH (default ./backups/) and old backups
# are pruned automatically.
#
# Assumptions:
# - The backup label is one of daily, weekly, or monthly.
# - The schedule manager passes BACKUP_RUN_KEY only for automated runs so the
#   service can remember when a particular cadence last completed.
#
# Usage:
#   ./backup.sh                         # Create a daily backup now
#   ./backup.sh --label weekly          # Create a weekly-labeled backup
#   ./backup.sh --cron                  # Silent mode for cron jobs
# =============================================================================
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/backups}"
BACKUP_LABEL="${BACKUP_LABEL:-daily}"
BACKUP_RUN_KEY="${BACKUP_RUN_KEY:-}"
CRON_MODE=false
RUNTIME="${BACKUP_RUNTIME:-}"
MONGO_URI="${MONGO_URI:-}"
BACKUP_LOG_FILE="${BACKUP_LOG_FILE:-$BACKUP_DIR/qlicker_backup.log}"
LOG_DEST_READY=false
HOST_UID=""
HOST_GID=""

ensure_log_destination() {
  if [ "$LOG_DEST_READY" = true ]; then
    return 0
  fi

  if mkdir -p "$BACKUP_DIR" >/dev/null 2>&1 && : >> "$BACKUP_LOG_FILE" 2>/dev/null; then
    LOG_DEST_READY=true
    return 0
  fi

  return 1
}

append_log_line() {
  level="$1"
  message="$2"

  if ensure_log_destination; then
    printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$message" >> "$BACKUP_LOG_FILE" 2>/dev/null || true
  fi
}

log() {
  append_log_line INFO "$*"
  if [ "$CRON_MODE" = false ]; then
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
  fi
}

error() {
  append_log_line ERROR "$*"
  printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

js_string() {
  # Emit a JavaScript string literal with the common shell-sensitive characters escaped.
  printf "'%s'" "$(printf '%s' "$1" | sed \
    -e "s/\\\\/\\\\\\\\/g" \
    -e "s/'/\\\\'/g" \
    -e 's/\r//g' \
    -e ':a;N;$!ba;s/\n/\\n/g')"
}

usage() {
  cat <<'EOF'
Usage: ./backup.sh [--cron] [--label daily|weekly|monthly|manual]
EOF
}

log_command_error_output() {
  context="$1"
  output="$2"

  if [ -n "$output" ]; then
    printf '%s\n' "$output" | while IFS= read -r line; do
      if [ -n "$line" ]; then
        error "$context output: $line"
      fi
    done
  else
    error "$context produced no additional output."
  fi
}

run_with_error_capture() {
  context="$1"
  shift

  command_output="$("$@" 2>&1)" && return 0
  error "$context failed."
  log_command_error_output "$context" "$command_output"
  return 1
}

is_nonnegative_integer() {
  case "${1:-}" in
    ''|*[!0-9]*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

remove_dump_directory() {
  host_path="$1"
  container_path="${2:-}"

  if rm -rf "$host_path" 2>/dev/null; then
    return 0
  fi

  # Host mode fallback: clean from inside the Mongo container when legacy
  # root-owned dump folders already exist on the bind mount.
  if [ "$RUNTIME" = "host" ] && [ -n "$container_path" ]; then
    if docker exec "$MONGO_CONTAINER" rm -rf "$container_path" >/dev/null 2>&1; then
      return 0
    fi
  fi

  return 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cron)
      CRON_MODE=true
      ;;
    --label)
      shift
      BACKUP_LABEL="${1:-}"
      ;;
    --label=*)
      BACKUP_LABEL="${1#*=}"
      ;;
    --run-key)
      shift
      BACKUP_RUN_KEY="${1:-}"
      ;;
    --run-key=*)
      BACKUP_RUN_KEY="${1#*=}"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      error "Unknown argument: $1"
      usage >&2
      exit 1
      ;;
  esac
  shift
done

case "$BACKUP_LABEL" in
  daily|weekly|monthly|manual)
    ;;
  *)
    error "Invalid backup label: $BACKUP_LABEL"
    exit 1
    ;;
esac

if [ -z "$RUNTIME" ]; then
  # When invoked from a production_setup checkout on the host, prefer the
  # sibling .env even if the parent shell has MONGO_URI exported already.
  if [ -f "$SCRIPT_DIR/.env" ]; then
    RUNTIME="host"
  elif [ -n "$MONGO_URI" ]; then
    RUNTIME="container"
  else
    RUNTIME="host"
  fi
fi

if [ "$RUNTIME" = "host" ]; then
  if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    . "$SCRIPT_DIR/.env"
    set +a
  else
    error ".env file not found. Run ./setup.sh first."
    exit 1
  fi
fi

if [ "$RUNTIME" = "host" ]; then
  MONGO_CONTAINER="$(docker compose -f "$SCRIPT_DIR/docker-compose.yml" ps -q mongo 2>/dev/null | head -n 1)"
  if [ -z "$MONGO_CONTAINER" ]; then
    error "MongoDB container is not running. Start with: docker compose up -d mongo"
    exit 1
  fi

  HOST_UID="$(id -u 2>/dev/null || printf '')"
  HOST_GID="$(id -g 2>/dev/null || printf '')"
  if ! is_nonnegative_integer "$HOST_UID" || ! is_nonnegative_integer "$HOST_GID"; then
    HOST_UID=""
    HOST_GID=""
  fi
else
  if [ -z "$MONGO_URI" ]; then
    error "MONGO_URI is required in container mode."
    exit 1
  fi
fi

mongo_eval() {
  if [ "$RUNTIME" = "host" ]; then
    docker exec "$MONGO_CONTAINER" mongosh "$MONGO_URI" --quiet --eval "$1"
  else
    mongosh "$MONGO_URI" --quiet --eval "$1"
  fi
}

read_retention_counts() {
  mongo_eval '
    const settings = db.getSiblingDB("qlicker").settings.findOne({ _id: "settings" }) || {};
    const daily = Number.isFinite(Number(settings.backupRetentionDaily)) ? Number(settings.backupRetentionDaily) : 7;
    const weekly = Number.isFinite(Number(settings.backupRetentionWeekly)) ? Number(settings.backupRetentionWeekly) : 4;
    const monthly = Number.isFinite(Number(settings.backupRetentionMonthly)) ? Number(settings.backupRetentionMonthly) : 12;
    print([daily, weekly, monthly].join("\t"));
  '
}

update_backup_status() {
  status="$1"
  filename="$2"
  message="$3"

  set_doc="backupLastRunAt: new Date(), backupLastRunType: $(js_string "$BACKUP_LABEL"), backupLastRunStatus: $(js_string "$status"), backupLastRunFilename: $(js_string "$filename"), backupLastRunMessage: $(js_string "$message")"

  if [ -n "$BACKUP_RUN_KEY" ]; then
    case "$BACKUP_LABEL" in
      daily)
        set_doc="$set_doc, backupLastDailyRunKey: $(js_string "$BACKUP_RUN_KEY")"
        ;;
      weekly)
        set_doc="$set_doc, backupLastWeeklyRunKey: $(js_string "$BACKUP_RUN_KEY")"
        ;;
      monthly)
        set_doc="$set_doc, backupLastMonthlyRunKey: $(js_string "$BACKUP_RUN_KEY")"
        ;;
      manual)
        set_doc="$set_doc, backupLastHandledManualRequestId: $(js_string "$BACKUP_RUN_KEY")"
        ;;
    esac
  fi

  mongo_eval "
    const dbName = db.getSiblingDB('qlicker');
    dbName.settings.updateOne(
      { _id: 'settings' },
      { \$set: { ${set_doc} } },
      { upsert: true }
    );
  " >/dev/null 2>&1 || return 0
}

prune_backups_for_label() {
  label="$1"
  keep_count="$2"

  case "$keep_count" in
    ''|*[!0-9]*)
      keep_count=0
      ;;
  esac

  if [ "$keep_count" -le 0 ]; then
    return 0
  fi

  label_glob="$BACKUP_DIR/qlicker_backup_*_${label}.tar.gz"
  pruned=0
  index=0
  for file in $(find -L "$BACKUP_DIR" -maxdepth 1 -type f -name "qlicker_backup_*_${label}.tar.gz" 2>/dev/null | sort -r); do
    index=$((index + 1))
    if [ "$index" -gt "$keep_count" ]; then
      rm -f "$file"
      pruned=$((pruned + 1))
    fi
  done

  if [ "$pruned" -gt 0 ]; then
    log "Pruned $pruned $label backup(s) beyond retention count $keep_count."
  fi
}

mkdir -p "$BACKUP_DIR"
if ! ensure_log_destination; then
  printf '[%s] WARN: Unable to write backup log file at %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$BACKUP_LOG_FILE" >&2
fi

TIMESTAMP="$(date '+%Y%m%d_%H%M%S')"
BACKUP_STEM="qlicker_backup_${TIMESTAMP}_${BACKUP_LABEL}"
DUMP_PATH_HOST="$BACKUP_DIR/$BACKUP_STEM"
ARCHIVE_PATH="$BACKUP_DIR/${BACKUP_STEM}.tar.gz"
ARCHIVE_NAME="$(basename "$ARCHIVE_PATH")"
log "Starting $BACKUP_LABEL backup: $BACKUP_STEM"

update_backup_status running "$ARCHIVE_NAME" "Backup started"

if [ "$RUNTIME" = "host" ]; then
  if [ -n "$HOST_UID" ] && [ -n "$HOST_GID" ]; then
    if run_with_error_capture "mongodump" \
      docker exec --user "$HOST_UID:$HOST_GID" "$MONGO_CONTAINER" mongodump \
        --uri="$MONGO_URI" \
        --out="/backups/$BACKUP_STEM" \
        --quiet; then
      :
    else
      update_backup_status failed "$ARCHIVE_NAME" "mongodump failed"
      error "mongodump failed!"
      exit 1
    fi
  else
    if run_with_error_capture "mongodump" \
      docker exec "$MONGO_CONTAINER" mongodump \
        --uri="$MONGO_URI" \
        --out="/backups/$BACKUP_STEM" \
        --quiet; then
      :
    else
      update_backup_status failed "$ARCHIVE_NAME" "mongodump failed"
      error "mongodump failed!"
      exit 1
    fi
  fi
else
  if run_with_error_capture "mongodump" \
    mongodump \
      --uri="$MONGO_URI" \
      --out="$DUMP_PATH_HOST" \
      --quiet; then
    :
  else
    update_backup_status failed "$ARCHIVE_NAME" "mongodump failed"
    error "mongodump failed!"
    exit 1
  fi
fi

if run_with_error_capture "tar compression" tar -czf "$ARCHIVE_PATH" -C "$BACKUP_DIR" "$BACKUP_STEM"; then
  if [ "$RUNTIME" = "host" ]; then
    if ! remove_dump_directory "$DUMP_PATH_HOST" "/backups/$BACKUP_STEM"; then
      update_backup_status failed "$ARCHIVE_NAME" "Backup archive created but dump cleanup failed"
      error "Backup archive created, but could not remove temporary dump directory."
      exit 1
    fi
  elif ! remove_dump_directory "$DUMP_PATH_HOST"; then
    update_backup_status failed "$ARCHIVE_NAME" "Backup archive created but dump cleanup failed"
    error "Backup archive created, but could not remove temporary dump directory."
    exit 1
  fi
else
  update_backup_status failed "$ARCHIVE_NAME" "Failed to compress backup archive"
  error "Failed to compress backup archive."
  exit 1
fi

if [ ! -f "$ARCHIVE_PATH" ]; then
  update_backup_status failed "$ARCHIVE_NAME" "Backup archive missing after compression"
  error "Backup archive not found after compression."
  exit 1
fi

BACKUP_SIZE="$(du -sh "$ARCHIVE_PATH" | cut -f1)"
update_backup_status success "$ARCHIVE_NAME" "Backup completed successfully"
log "Compressed: $(basename "$ARCHIVE_PATH") ($BACKUP_SIZE)"

read_retention_counts | {
  IFS="$(printf '\t')"
  read -r RETENTION_DAILY RETENTION_WEEKLY RETENTION_MONTHLY
  prune_backups_for_label daily "${RETENTION_DAILY:-7}"
  prune_backups_for_label weekly "${RETENTION_WEEKLY:-4}"
  prune_backups_for_label monthly "${RETENTION_MONTHLY:-12}"
}

TOTAL_BACKUPS="$(find -L "$BACKUP_DIR" -maxdepth 1 -type f -name 'qlicker_backup_*.tar.gz' 2>/dev/null | wc -l | tr -d ' ')"
log "Backup complete. Total backups: $TOTAL_BACKUPS"
