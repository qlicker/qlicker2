#!/usr/bin/env bash
# =============================================================================
# Qlicker Production — Enable MongoDB and Redis Authentication
# =============================================================================
# Safely migrates an existing production_setup deployment to authenticated
# MongoDB + Redis by taking a backup, recreating the data services with auth
# enabled, restoring the database, and restarting the stack.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
BACKUP_DIR="$SCRIPT_DIR/backups"
TIMESTAMP="$(date '+%Y%m%d_%H%M%S')"
MIGRATION_SNAPSHOT_DIR="$BACKUP_DIR/auth-migration-$TIMESTAMP"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "Missing required command: $1"
    exit 1
  fi
}

choose_token_value() {
  local token_name="$1" existing_value="$2" output_var="$3" selected response
  if [ -n "$existing_value" ]; then
    while true; do
      read -r -p "$token_name already exists. Keep? [Y/n]: " response
      case "${response:-Y}" in
        [Yy]*) selected="$existing_value"; break ;;
        [Nn]*) selected="$(openssl rand -hex 32)"; info "Generated new $token_name"; break ;;
        *) echo "Please answer y or n." ;;
      esac
    done
  else
    selected="$(openssl rand -hex 32)"
    info "Generated $token_name"
  fi
  printf -v "$output_var" '%s' "$selected"
}

upsert_env_var() {
  local key="$1" value="$2" file_path="$3" tmp_file
  tmp_file="$(mktemp)"
  chmod 600 "$tmp_file" 2>/dev/null || true

  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    $0 ~ ("^" key "=") {
      print key "=" value
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) print key "=" value
    }
  ' "$file_path" > "$tmp_file"

  mv "$tmp_file" "$file_path"
}

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

detect_compose_project_name() {
  local container_id=""
  for service in nginx server mongo redis client; do
    container_id="$(compose ps -q "$service" 2>/dev/null | head -1 || true)"
    if [ -n "$container_id" ]; then
      docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$container_id" 2>/dev/null || true
      return 0
    fi
  done

  warn "Could not detect a running compose project label; falling back to the directory name."
  basename "$SCRIPT_DIR"
}

volume_id_for() {
  local volume_name="$1"
  docker volume ls -q \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --filter "label=com.docker.compose.volume=$volume_name" | head -1
}

remove_volume_if_present() {
  local volume_name="$1"
  local volume_id=""
  volume_id="$(volume_id_for "$volume_name")"
  if [ -z "$volume_id" ]; then
    warn "Volume '$volume_name' was not found for compose project '$COMPOSE_PROJECT_NAME'."
    return 0
  fi

  docker volume rm "$volume_id" >/dev/null
  info "Removed volume: $volume_id"
}

wait_for_service_healthy() {
  local service="$1" timeout_seconds="${2:-180}" container_id="" status="" waited=0

  while [ "$waited" -lt "$timeout_seconds" ]; do
    container_id="$(compose ps -q "$service" 2>/dev/null | head -1 || true)"
    if [ -n "$container_id" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      case "$status" in
        healthy|running)
          info "$service is $status."
          return 0
          ;;
      esac
    fi
    sleep 2
    waited=$((waited + 2))
  done

  error "Timed out waiting for $service to become healthy."
  return 1
}

latest_backup_for_pattern() {
  local pattern="$1"
  find -L "$BACKUP_DIR" -maxdepth 1 -type f -name "$pattern" 2>/dev/null | sort -r | head -1
}

on_error() {
  error "Migration failed."
  error "Config snapshots: $MIGRATION_SNAPSHOT_DIR"
  if [ -n "${BACKUP_FILE:-}" ]; then
    error "Database backup archive: $BACKUP_FILE"
  fi
}
trap on_error ERR

require_command docker
require_command openssl

if ! docker compose version >/dev/null 2>&1; then
  error "'docker compose' is required."
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  error ".env file not found. Run ./setup.sh first."
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  error "Compose file not found: $COMPOSE_FILE"
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

mkdir -p "$MIGRATION_SNAPSHOT_DIR"
cp "$ENV_FILE" "$MIGRATION_SNAPSHOT_DIR/.env.before"
cp "$COMPOSE_FILE" "$MIGRATION_SNAPSHOT_DIR/docker-compose.yml.before"

COMPOSE_PROJECT_NAME="$(detect_compose_project_name)"
DEFAULT_MONGO_USERNAME="${MONGO_INITDB_ROOT_USERNAME:-qlickerAdmin}"

echo ""
echo "======================================"
echo "  Qlicker — Enable DB Authentication"
echo "======================================"
echo ""
echo "This script will:"
echo "  1. Create a fresh manual database backup"
echo "  2. Back up the current .env and docker-compose.yml"
echo "  3. Write MongoDB/Redis authentication settings into .env"
echo "  4. Stop the stack, recreate mongo/redis data volumes, and restore the backup"
echo "  5. Start the full application again"
echo ""
echo "Config snapshot directory: $MIGRATION_SNAPSHOT_DIR"
echo ""

read -r -p "MongoDB admin username [$DEFAULT_MONGO_USERNAME]: " MONGO_USERNAME_INPUT
MONGO_INITDB_ROOT_USERNAME="${MONGO_USERNAME_INPUT:-$DEFAULT_MONGO_USERNAME}"
choose_token_value "MONGO_INITDB_ROOT_PASSWORD" "${MONGO_INITDB_ROOT_PASSWORD:-}" MONGO_INITDB_ROOT_PASSWORD
choose_token_value "REDIS_PASSWORD" "${REDIS_PASSWORD:-}" REDIS_PASSWORD

echo ""
warn "The application will be unavailable during this migration."
read -r -p "Type 'migrate' to continue: " CONFIRM
if [ "$CONFIRM" != "migrate" ]; then
  echo "Cancelled."
  exit 0
fi

info "Creating a pre-migration backup..."
BACKUP_RUNTIME=host "$SCRIPT_DIR/backup.sh" --label manual
BACKUP_FILE="$(latest_backup_for_pattern 'qlicker_backup_*_manual.tar.gz')"
if [ -z "$BACKUP_FILE" ]; then
  error "Could not locate the manual backup archive created by backup.sh."
  exit 1
fi
info "Backup archive: $BACKUP_FILE"

MONGO_URI="mongodb://${MONGO_INITDB_ROOT_USERNAME}:${MONGO_INITDB_ROOT_PASSWORD}@mongo:27017/qlicker?authSource=admin"
REDIS_URL="redis://:${REDIS_PASSWORD}@redis:6379"

info "Updating .env with authenticated MongoDB and Redis settings..."
upsert_env_var "MONGO_INITDB_ROOT_USERNAME" "$MONGO_INITDB_ROOT_USERNAME" "$ENV_FILE"
upsert_env_var "MONGO_INITDB_ROOT_PASSWORD" "$MONGO_INITDB_ROOT_PASSWORD" "$ENV_FILE"
upsert_env_var "MONGO_URI" "$MONGO_URI" "$ENV_FILE"
upsert_env_var "REDIS_PASSWORD" "$REDIS_PASSWORD" "$ENV_FILE"
upsert_env_var "REDIS_URL" "$REDIS_URL" "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || warn "Could not restrict $ENV_FILE to mode 600."
cp "$ENV_FILE" "$MIGRATION_SNAPSHOT_DIR/.env.after"

info "Stopping the application stack..."
compose down --remove-orphans

info "Removing old MongoDB and Redis data volumes..."
remove_volume_if_present "mongo-data"
remove_volume_if_present "redis-data"

info "Starting authenticated MongoDB and Redis containers..."
compose up -d mongo redis
wait_for_service_healthy mongo 180
wait_for_service_healthy redis 120

info "Restoring the backup into the new authenticated MongoDB volume..."
"$SCRIPT_DIR/restore.sh" --yes "$BACKUP_FILE"

info "Starting the full stack..."
compose up -d
wait_for_service_healthy mongo 180
wait_for_service_healthy redis 120

echo ""
info "Migration completed."
info "Config snapshots: $MIGRATION_SNAPSHOT_DIR"
info "Database backup: $BACKUP_FILE"
compose ps
