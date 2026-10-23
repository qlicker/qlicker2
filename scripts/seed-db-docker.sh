#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_ROOT/.env"
  set +a
fi

SERVER_CONTAINER="$(docker compose ps -q server 2>/dev/null | head -1)"
MONGO_CONTAINER="$(docker compose ps -q mongo 2>/dev/null | head -1)"

if [ -z "$SERVER_CONTAINER" ] || [ -z "$MONGO_CONTAINER" ]; then
  echo "Server and mongo containers must be running."
  echo "Start them with: docker compose up -d server mongo"
  exit 1
fi

DOCKER_MONGO_URI="$(docker exec "$SERVER_CONTAINER" printenv MONGO_URI 2>/dev/null | tr -d '\r')"
if [ -z "$DOCKER_MONGO_URI" ]; then
  echo "MONGO_URI is not set in the server container environment."
  echo "Set MONGO_URI via .env/docker compose before running this script."
  exit 1
fi

db_name_from_uri() {
  local uri="$1"
  local no_query="${uri%%\?*}"
  local db_name="${no_query##*/}"
  if [ -z "$db_name" ] || [ "$db_name" = "$no_query" ]; then
    db_name="qlicker"
  fi
  printf '%s\n' "$db_name"
}

uri_without_db_from_uri() {
  local uri="$1"
  local base="${uri%%\?*}"
  local query=""
  if [ "$base" != "$uri" ]; then
    query="?${uri#*\?}"
  fi

  if [[ "$base" =~ ^(mongodb(\+srv)?://[^/]+)/[^/]+$ ]]; then
    printf '%s%s\n' "${BASH_REMATCH[1]}" "$query"
    return 0
  fi

  printf '%s%s\n' "$base" "$query"
}

confirm_action() {
  local prompt="$1"
  local answer
  read -r -p "$prompt [y/N]: " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

find_legacy_candidates() {
  local legacy_root="$PROJECT_ROOT/legacydb"
  if [ ! -d "$legacy_root" ]; then
    return 0
  fi

  find "$legacy_root" -type f -name '*.bson' ! -name 'oplog.bson' \
    | while IFS= read -r file; do
        local rel top
        rel="${file#$legacy_root/}"
        top="${rel%%/*}"
        if [ "$top" != "$rel" ]; then
          printf '%s\n' "$legacy_root/$top"
        fi
      done \
    | sort -u
}

is_system_database_name() {
  case "$1" in
    admin|local|config)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

list_dump_databases() {
  local dump_root="$1"
  find "$dump_root" -mindepth 1 -maxdepth 1 -type d \
    | while IFS= read -r db_dir; do
        if find "$db_dir" -maxdepth 1 -type f -name '*.bson' | grep -q .; then
          basename "$db_dir"
        fi
      done \
    | sort -u
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

SELECTED_LEGACY_DIR=""

select_legacy_directory() {
  mapfile -t candidates < <(find_legacy_candidates)
  if [ "${#candidates[@]}" -eq 0 ]; then
    echo "No mongodump database directories found under legacydb/."
    return 1
  fi

  if [ "${#candidates[@]}" -eq 1 ]; then
    SELECTED_LEGACY_DIR="${candidates[0]}"
    echo "Using legacy dump: ${SELECTED_LEGACY_DIR#$PROJECT_ROOT/}"
    return 0
  fi

  echo "Found legacy dump directories:"
  for i in "${!candidates[@]}"; do
    echo "  $((i + 1))) ${candidates[$i]#$PROJECT_ROOT/}"
  done

  while true; do
    local choice
    read -r -p "Choose a directory [1-${#candidates[@]}]: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#candidates[@]}" ]; then
      SELECTED_LEGACY_DIR="${candidates[$((choice - 1))]}"
      return 0
    fi
    echo "Invalid choice."
  done
}

run_seed() {
  local temp_seed_script="/app/.seed-db-tmp.js"

  echo "Copying seed script to server container..."
  docker cp "$SCRIPT_DIR/seed-db.js" "$SERVER_CONTAINER:$temp_seed_script"

  echo "Running seed script inside container..."
  local status=0
  if docker exec "$SERVER_CONTAINER" node "$temp_seed_script" "$@"; then
    status=0
  else
    status=$?
  fi

  echo "Cleaning up..."
  docker exec -u 0 "$SERVER_CONTAINER" rm -f "$temp_seed_script" >/dev/null 2>&1 || true

  if [ "$status" -ne 0 ]; then
    return "$status"
  fi

  echo "Done."
}

reset_to_empty() {
  local target_db
  target_db="$(db_name_from_uri "$DOCKER_MONGO_URI")"

  if ! confirm_action "This will drop all data in '$target_db' via Docker mongo. Continue?"; then
    echo "Canceled."
    return 0
  fi

  docker exec "$MONGO_CONTAINER" mongosh "$DOCKER_MONGO_URI" --quiet --eval 'db.dropDatabase()' >/dev/null
  echo "Database '$target_db' reset to empty."
}

restore_legacy_dump() {
  if ! select_legacy_directory; then
    return 1
  fi

  local dump_root_name target_db restore_uri temp_dump_dir status primary_source_db db_name restore_db
  local -a dump_databases

  mapfile -t dump_databases < <(list_dump_databases "$SELECTED_LEGACY_DIR")
  if [ "${#dump_databases[@]}" -eq 0 ]; then
    echo "No database directories found in selected dump."
    return 1
  fi

  if ! primary_source_db="$(pick_primary_app_database "${dump_databases[@]}")"; then
    echo "Unable to determine primary application database in selected dump."
    return 1
  fi

  dump_root_name="$(basename "$SELECTED_LEGACY_DIR")"
  target_db="$(db_name_from_uri "$DOCKER_MONGO_URI")"
  restore_uri="$(uri_without_db_from_uri "$DOCKER_MONGO_URI")"
  temp_dump_dir="/tmp/legacy-restore-$$"
  status=0

  echo "Restore dump: ${SELECTED_LEGACY_DIR#$PROJECT_ROOT/}"
  echo "Databases in dump: ${dump_databases[*]}"
  echo "Primary application database: $primary_source_db"
  echo "Restore target database: $target_db"

  if ! confirm_action "This will overwrite all data in '$target_db'. Continue?"; then
    echo "Canceled."
    return 0
  fi

  echo "Copying dump into mongo container..."
  docker exec "$MONGO_CONTAINER" rm -rf "$temp_dump_dir"
  docker exec "$MONGO_CONTAINER" mkdir -p "$temp_dump_dir"
  docker cp "$SELECTED_LEGACY_DIR" "$MONGO_CONTAINER:$temp_dump_dir/"

  echo "Running mongorestore inside mongo container..."
  for db_name in "${dump_databases[@]}"; do
    restore_db="$db_name"
    if [ "$db_name" = "$primary_source_db" ]; then
      restore_db="$target_db"
    fi

    echo "Restoring database '$db_name' -> '$restore_db'..."
    if docker exec "$MONGO_CONTAINER" mongorestore \
      --drop \
      --uri="$restore_uri" \
      --db="$restore_db" \
      "$temp_dump_dir/$dump_root_name/$db_name"; then
      status=0
    else
      status=$?
      break
    fi
  done

  docker exec "$MONGO_CONTAINER" rm -rf "$temp_dump_dir" >/dev/null 2>&1 || true

  if [ "$status" -ne 0 ]; then
    return "$status"
  fi

  echo "Legacy restore complete."
}

interactive_menu() {
  echo "Select database action:"
  echo "  1) Seed with test users"
  echo "  2) Restore from legacy dump"
  echo "  3) Reset database to empty"

  local choice
  read -r -p "Enter choice [1-3]: " choice

  case "$choice" in
    1)
      run_seed
      ;;
    2)
      restore_legacy_dump
      ;;
    3)
      reset_to_empty
      ;;
    *)
      echo "Invalid choice."
      exit 1
      ;;
  esac
}

if [ "$#" -gt 0 ]; then
  case "$1" in
    --legacy-restore)
      restore_legacy_dump
      ;;
    --reset)
      run_seed --reset
      ;;
    --reset-empty)
      reset_to_empty
      ;;
    --menu)
      interactive_menu
      ;;
    *)
      run_seed "$@"
      ;;
  esac
else
  run_seed
fi
