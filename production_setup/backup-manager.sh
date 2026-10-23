#!/usr/bin/env sh
# =============================================================================
# Qlicker Production — Backup Manager
# =============================================================================
# Runs inside Docker and triggers backup.sh when the configured schedule is due.
#
# Scheduling assumptions:
# - Daily backups run every day at backupTimeLocal.
# - Weekly backups run on Sundays at backupTimeLocal.
# - Monthly backups run on the first day of each month at backupTimeLocal.
# - The loop checks once per minute, so the effective trigger window is one minute.
# =============================================================================
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BACKUP_SCRIPT="${BACKUP_SCRIPT:-$SCRIPT_DIR/backup.sh}"
MONGO_URI="${MONGO_URI:-mongodb://mongo:27017/qlicker}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_CHECK_INTERVAL_SECONDS="${BACKUP_CHECK_INTERVAL_SECONDS:-60}"
BACKUP_HOST_PATH="${BACKUP_HOST_PATH:-./backups}"
BACKUP_LOG_FILE="${BACKUP_LOG_FILE:-$BACKUP_DIR/qlicker_backup.log}"
LOG_DEST_READY=false

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
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

error() {
  append_log_line ERROR "$*"
  printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

js_string() {
  printf "'%s'" "$(printf '%s' "$1" | sed \
    -e "s/\\\\/\\\\\\\\/g" \
    -e "s/'/\\\\'/g" \
    -e 's/\r//g' \
    -e ':a;N;$!ba;s/\n/\\n/g')"
}

sanitize_positive_integer() {
  value="$1"
  fallback="$2"

  case "$value" in
    ''|*[!0-9]*)
      printf '%s' "$fallback"
      ;;
    *)
      if [ "$value" -gt 0 ] 2>/dev/null; then
        printf '%s' "$value"
      else
        printf '%s' "$fallback"
      fi
      ;;
  esac
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

strip_leading_zeros() {
  value="${1:-0}"

  while [ "${#value}" -gt 1 ] && [ "${value#0}" != "$value" ]; do
    value="${value#0}"
  done

  if [ -z "$value" ]; then
    value=0
  fi

  printf '%s' "$value"
}

time_to_minutes() {
  time_value="$1"
  hours="$(strip_leading_zeros "${time_value%:*}")"
  minutes="$(strip_leading_zeros "${time_value#*:}")"
  printf '%s' "$((hours * 60 + minutes))"
}

BACKUP_CHECK_INTERVAL_SECONDS="$(sanitize_positive_integer "$BACKUP_CHECK_INTERVAL_SECONDS" 60)"
if ! ensure_log_destination; then
  printf '[%s] WARN: Unable to write backup log file at %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$BACKUP_LOG_FILE" >&2
fi
log "Backup manager started. Writing logs to $BACKUP_LOG_FILE and archives to $BACKUP_DIR."

update_manager_status() {
  status="$1"
  message="$2"

  if ! command -v mongosh >/dev/null 2>&1; then
    return 0
  fi

  mongosh "$MONGO_URI" --quiet --eval "
    db.getSiblingDB('qlicker').settings.updateOne(
      { _id: 'settings' },
      {
        \$set: {
          backupManagerLastSeenAt: new Date(),
          backupManagerCheckIntervalSeconds: $BACKUP_CHECK_INTERVAL_SECONDS,
          backupManagerStatus: $(js_string "$status"),
          backupManagerMessage: $(js_string "$message"),
          backupManagerHostPath: $(js_string "$BACKUP_HOST_PATH")
        }
      },
      { upsert: true }
    );
  " >/dev/null 2>&1 || return 0
}

query_backup_state() {
  query_output="$(mongosh "$MONGO_URI" --quiet --eval '
    const settings = db.getSiblingDB("qlicker").settings.findOne({ _id: "settings" }) || {};
    print([
      settings.backupEnabled === true ? "true" : "false",
      settings.backupTimeLocal || "02:00",
      settings.backupLastDailyRunKey || "",
      settings.backupLastWeeklyRunKey || "",
      settings.backupLastMonthlyRunKey || "",
      settings.backupManualRequestId || "",
      settings.backupLastHandledManualRequestId || ""
    ].join("|"));
  ' 2>&1)" || {
    error "Failed to read backup settings from MongoDB."
    log_command_error_output "Read backup settings" "$query_output"
    return 1
  }

  printf '%s\n' "$query_output"
}

run_backup() {
  label="$1"
  run_key="$2"

  BACKUP_RUNTIME=container \
  BACKUP_LOG_FILE="$BACKUP_LOG_FILE" \
  BACKUP_HOST_PATH="$BACKUP_HOST_PATH" \
  MONGO_URI="$MONGO_URI" \
  BACKUP_DIR="$BACKUP_DIR" \
  BACKUP_LABEL="$label" \
  BACKUP_RUN_KEY="$run_key" \
  "$BACKUP_SCRIPT"
}

should_run_daily() {
  current_date="$1"
  last_daily_key="$2"
  [ "$last_daily_key" != "$current_date" ]
}

should_run_weekly() {
  current_week="$1"
  last_weekly_key="$2"
  [ "$last_weekly_key" != "$current_week" ]
}

should_run_monthly() {
  current_month="$1"
  last_monthly_key="$2"
  [ "$last_monthly_key" != "$current_month" ]
}

validate_runtime() {
  for cmd in mongosh mongodump tar find mkdir rm touch; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      message="Backup manager is missing required command '$cmd'."
      error "$message"
      update_manager_status error "$message"
      return 1
    fi
  done

  if ! mkdir -p "$BACKUP_DIR"; then
    message="Backup directory $BACKUP_DIR could not be created. Host path $BACKUP_HOST_PATH must be writable."
    error "$message"
    update_manager_status error "$message"
    return 1
  fi

  probe_file="$BACKUP_DIR/.qlicker-backup-write-test.$$"
  if ! : > "$probe_file" 2>/dev/null; then
    message="Backup directory $BACKUP_DIR is not writable. Host path $BACKUP_HOST_PATH must be writable."
    error "$message"
    update_manager_status error "$message"
    return 1
  fi
  rm -f "$probe_file"

  if ! run_with_error_capture "MongoDB ping check" mongosh "$MONGO_URI" --quiet --eval 'db.runCommand({ ping: 1 }).ok'; then
    message="Backup manager cannot reach MongoDB using the configured MONGO_URI."
    error "$message"
    update_manager_status error "$message"
    return 1
  fi

  update_manager_status healthy "Backup manager is running. Archives are written to $BACKUP_HOST_PATH on the host."
  return 0
}

process_backup() {
  label="$1"
  run_key="$2"

  if run_backup "$label" "$run_key"; then
    update_manager_status healthy "Backup manager is running. Archives are written to $BACKUP_HOST_PATH on the host."
    return 0
  fi

  message="The $label backup failed. Check the last run status below and the backup-manager container logs."
  error "$message"
  update_manager_status warning "$message"
  return 1
}

while :; do
  if ! validate_runtime; then
    sleep "$BACKUP_CHECK_INTERVAL_SECONDS"
    continue
  fi

  if ! state="$(query_backup_state)"; then
    message="Backup manager could not read backup settings from MongoDB. Retrying."
    error "$message"
    update_manager_status warning "$message"
    sleep "$BACKUP_CHECK_INTERVAL_SECONDS"
    continue
  fi

  IFS='|' read -r BACKUP_ENABLED BACKUP_TIME_LOCAL LAST_DAILY_KEY LAST_WEEKLY_KEY LAST_MONTHLY_KEY MANUAL_REQUEST_ID LAST_HANDLED_MANUAL_REQUEST_ID <<EOF_STATE
$state
EOF_STATE

  if [ -n "${MANUAL_REQUEST_ID:-}" ] && [ "${MANUAL_REQUEST_ID:-}" != "${LAST_HANDLED_MANUAL_REQUEST_ID:-}" ]; then
    process_backup manual "$MANUAL_REQUEST_ID" || true
    sleep "$BACKUP_CHECK_INTERVAL_SECONDS"
    continue
  fi

  if [ "$BACKUP_ENABLED" = "true" ]; then
    current_time="$(date '+%H:%M')"
    current_date="$(date '+%F')"
    current_week="$(date '+%G-W%V')"
    current_month="$(date '+%Y-%m')"
    current_weekday="$(date '+%u')"
    current_minutes="$(time_to_minutes "$current_time")"
    scheduled_minutes="$(time_to_minutes "${BACKUP_TIME_LOCAL:-02:00}")"

    if [ "$current_minutes" -ge "$scheduled_minutes" ]; then
      if should_run_daily "$current_date" "${LAST_DAILY_KEY:-}"; then
        process_backup daily "$current_date" || true
      fi

      if [ "$current_weekday" = "7" ] && should_run_weekly "$current_week" "${LAST_WEEKLY_KEY:-}"; then
        process_backup weekly "$current_week" || true
      fi

      if [ "$(date '+%d')" = "01" ] && should_run_monthly "$current_month" "${LAST_MONTHLY_KEY:-}"; then
        process_backup monthly "$current_month" || true
      fi
    fi
  fi

  sleep "$BACKUP_CHECK_INTERVAL_SECONDS"
done
