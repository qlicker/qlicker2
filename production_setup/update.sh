#!/usr/bin/env bash
# =============================================================================
# Qlicker Production — Update Script
# =============================================================================
# Pulls the latest Docker images and performs a rolling restart.
# If using locally built images, rebuilds them first.
#
# Usage:
#   ./update.sh              # Pull/rebuild and restart
#   ./update.sh --build      # Force rebuild from source
#   ./update.sh --no-backup  # Skip pre-update backup
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
FORCE_BUILD=false
SKIP_BACKUP=false
SERVER_IMAGE="${SERVER_IMAGE:-qlicker/qlicker-server:latest}"
CLIENT_IMAGE="${CLIENT_IMAGE:-qlicker/qlicker-client:latest}"

for arg in "$@"; do
  case "$arg" in
    --build)    FORCE_BUILD=true ;;
    --no-backup) SKIP_BACKUP=true ;;
    --help|-h)
      echo "Usage: ./update.sh [--build] [--no-backup]"
      echo "  --build      Force rebuild of Docker images from source"
      echo "  --no-backup  Skip the pre-update database backup"
      exit 0
      ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }

show_image_details() {
  local label="$1"
  local image_ref="$2"
  local repo_digest
  local image_id

  repo_digest="$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}<none>{{end}}' "$image_ref" 2>/dev/null || true)"
  image_id="$(docker image inspect --format '{{.Id}}' "$image_ref" 2>/dev/null || true)"

  info "$label image: $image_ref"
  info "$label digest: ${repo_digest:-<unavailable>}"
  info "$label image ID: ${image_id:-<unavailable>}"
}

pull_image() {
  local label="$1"
  local image_ref="$2"

  info "Force-pulling $label image from registry: $image_ref"
  info "This refreshes the tag from the registry even if the same tag already exists on this server."
  docker pull "$image_ref"
  show_image_details "$label" "$image_ref"
}

# Load .env
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; . "$SCRIPT_DIR/.env"; set +a
else
  error ".env file not found. Run ./setup.sh first."
  exit 1
fi

SERVER_IMAGE="${SERVER_IMAGE:-qlicker/qlicker-server:latest}"
CLIENT_IMAGE="${CLIENT_IMAGE:-qlicker/qlicker-client:latest}"

echo "======================================"
echo "  Qlicker — Update"
echo "======================================"
echo ""

# ---- Pre-update backup ------------------------------------------------------
if [ "$SKIP_BACKUP" = false ]; then
  info "Creating pre-update backup..."
  if "$SCRIPT_DIR/backup.sh"; then
    info "Backup complete."
  else
    warn "Backup failed — continuing with update anyway."
  fi
  echo ""
fi

# ---- Pull or rebuild images -------------------------------------------------
if [ "$FORCE_BUILD" = true ]; then
  info "Rebuilding Docker images from source..."
  docker compose -f "$COMPOSE_FILE" build --no-cache server client
  show_image_details "server" "$SERVER_IMAGE"
  show_image_details "client" "$CLIENT_IMAGE"
else
  info "Refreshing tagged images from the registry."
  info "Visible docker pull output follows so it is clear the update checks for new image content every time."
  if pull_image "server" "$SERVER_IMAGE" && pull_image "client" "$CLIENT_IMAGE"; then
    info "Remote images refreshed."
  else
    info "Pull not available (using local builds). Rebuilding..."
    docker compose -f "$COMPOSE_FILE" build server client
    show_image_details "server" "$SERVER_IMAGE"
    show_image_details "client" "$CLIENT_IMAGE"
  fi
fi

# ---- Rolling restart --------------------------------------------------------
echo ""
info "Restarting services..."

# Restart server replicas (rolling — Docker Compose restarts one at a time)
docker compose -f "$COMPOSE_FILE" up -d --no-deps server
info "Server replicas restarted."

# The collector shares the server image but runs independently of API replicas.
docker compose -f "$COMPOSE_FILE" up -d --no-deps system-monitor
info "System monitor restarted."

# Restart client
docker compose -f "$COMPOSE_FILE" up -d --no-deps client
info "Client restarted."

# Restart nginx to pick up any config changes
docker compose -f "$COMPOSE_FILE" up -d --no-deps nginx
info "Nginx restarted."

# ---- Health check -----------------------------------------------------------
echo ""
info "Waiting for health check..."
sleep 5

DOMAIN="${DOMAIN:-localhost}"
HEALTH_URL="https://$DOMAIN/api/v1/health"

# Try health check (allow self-signed certs with -k)
if curl -sSfk "$HEALTH_URL" -o /dev/null 2>/dev/null; then
  info "Health check passed: $HEALTH_URL"
else
  warn "Health check failed or timed out. Check logs:"
  echo "  docker compose logs -f server"
fi

echo ""
info "Update complete!"
docker compose -f "$COMPOSE_FILE" ps
