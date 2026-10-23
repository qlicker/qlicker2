#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
SERVER_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q server 2>/dev/null | head -1)"

if [ -z "$SERVER_CONTAINER" ]; then
  echo "Server container is not running. Start with: docker compose up -d server"
  exit 1
fi

exec docker exec -i "$SERVER_CONTAINER" node --input-type=module - "$@" < "$SCRIPT_DIR/sanitize-s3.js"
