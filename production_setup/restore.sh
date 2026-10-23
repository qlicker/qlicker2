#!/usr/bin/env bash
# =============================================================================
# Qlicker Production — MongoDB Restore Script
# =============================================================================
# Restores a Qlicker database from a backup created by backup.sh.
#
# Usage:
#   ./restore.sh                                    # Interactive: pick from list
#   ./restore.sh backups/qlicker_backup_20260101_020000_daily.tar.gz  # Specific file
#   ./restore.sh --yes backups/qlicker_backup_20260101_020000_daily.tar.gz
# The selector still accepts older qlicker_backup_YYYYMMDD_HHmmss.tar.gz archives.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR/backups"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }

# Load .env
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; . "$SCRIPT_DIR/.env"; set +a
else
  error ".env file not found. Run ./setup.sh first."
  exit 1
fi

# Get mongo container
MONGO_CONTAINER="$(docker compose -f "$SCRIPT_DIR/docker-compose.yml" ps -q mongo 2>/dev/null | head -1)"
if [ -z "$MONGO_CONTAINER" ]; then
  error "MongoDB container is not running. Start with: docker compose up -d mongo"
  exit 1
fi

# ---- Parse args -------------------------------------------------------------
AUTO_CONFIRM=false
BACKUP_FILE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes)
      AUTO_CONFIRM=true
      ;;
    --help|-h)
      echo "Usage: ./restore.sh [--yes] [backup-file]"
      exit 0
      ;;
    *)
      if [ -n "$BACKUP_FILE" ]; then
        error "Unexpected argument: $1"
        exit 1
      fi
      BACKUP_FILE="$1"
      ;;
  esac
  shift
done

# ---- Select backup ----------------------------------------------------------

if [ -z "$BACKUP_FILE" ]; then
  mapfile -t BACKUPS < <(find -L "$BACKUP_DIR" -name 'qlicker_backup_*.tar.gz' -type f 2>/dev/null | sort -r)

  if [ "${#BACKUPS[@]}" -eq 0 ]; then
    error "No backups found in $BACKUP_DIR"
    exit 1
  fi

  echo "Available backups:"
  for i in "${!BACKUPS[@]}"; do
    SIZE="$(du -sh "${BACKUPS[$i]}" | cut -f1)"
    BASENAME="$(basename "${BACKUPS[$i]}")"
    printf "  %d) %s  (%s)\n" "$((i + 1))" "$BASENAME" "$SIZE"
  done
  echo ""

  while true; do
    read -r -p "Select backup to restore [1-${#BACKUPS[@]}]: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#BACKUPS[@]}" ]; then
      BACKUP_FILE="${BACKUPS[$((choice - 1))]}"
      break
    fi
    echo "Invalid choice."
  done
fi

if [ ! -f "$BACKUP_FILE" ]; then
  error "Backup file not found: $BACKUP_FILE"
  exit 1
fi

BACKUP_BASENAME="$(basename "$BACKUP_FILE" .tar.gz)"
info "Selected: $BACKUP_BASENAME"

# ---- Confirm ----------------------------------------------------------------
echo ""
warn "This will DROP the current 'qlicker' database and restore from backup."
if [ "$AUTO_CONFIRM" = true ]; then
  info "Auto-confirm enabled; continuing without interactive confirmation."
else
  read -r -p "Are you sure? Type 'yes' to continue: " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo "Cancelled."
    exit 0
  fi
fi

# ---- Extract and restore ----------------------------------------------------
TEMP_DIR="/tmp/qlicker-restore-$$"
mkdir -p "$TEMP_DIR"
trap 'rm -rf "$TEMP_DIR"' EXIT

info "Extracting backup..."
tar xzf "$BACKUP_FILE" -C "$TEMP_DIR"

# Find the dump directory
DUMP_DIR="$(find "$TEMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [ -z "$DUMP_DIR" ]; then
  error "No dump directory found in archive."
  exit 1
fi

# Copy dump into mongo container
CONTAINER_TEMP="/tmp/restore-$$"
docker exec "$MONGO_CONTAINER" mkdir -p "$CONTAINER_TEMP"
docker cp "$DUMP_DIR/." "$MONGO_CONTAINER:$CONTAINER_TEMP/"

info "Restoring database..."
if docker exec "$MONGO_CONTAINER" mongorestore \
  --uri="$MONGO_URI" \
  --db=qlicker \
  --drop \
  "$CONTAINER_TEMP/qlicker" \
  --quiet; then
  info "Database restored successfully from $BACKUP_BASENAME"
else
  error "mongorestore failed!"
  docker exec "$MONGO_CONTAINER" rm -rf "$CONTAINER_TEMP" 2>/dev/null || true
  exit 1
fi

# Cleanup
docker exec "$MONGO_CONTAINER" rm -rf "$CONTAINER_TEMP" 2>/dev/null || true

info "Restore complete. You may want to restart the server:"
echo "  docker compose restart server"
