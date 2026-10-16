#!/bin/bash
set -e

echo "======================================"
echo "  Qlicker - Docker Setup Script"
echo "======================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EXISTING_ENV_FILE="$PROJECT_ROOT/.env"
APP_VERSION="${APP_VERSION:-$(tr -d '[:space:]' < "$PROJECT_ROOT/VERSION")}"

if [ -f "$EXISTING_ENV_FILE" ]; then
  echo "[INFO] Existing .env found at $EXISTING_ENV_FILE"
  echo "       Using current values as setup defaults."
  set -a
  # shellcheck disable=SC1090
  . "$EXISTING_ENV_FILE"
  set +a
fi

choose_token_value() {
  local token_name="$1"
  local existing_value="$2"
  local output_var="$3"
  local selected_value response

  if [ -n "$existing_value" ]; then
    while true; do
      read -r -p "$token_name exists in .env. Keep existing value? [Y/n]: " response
      case "$response" in
        ""|[Yy])
          selected_value="$existing_value"
          break
          ;;
        [Nn])
          selected_value="$(openssl rand -hex 32)"
          echo "[OK] Generated new $token_name"
          break
          ;;
        *)
          echo "Please answer y or n."
          ;;
      esac
    done
  else
    selected_value="$(openssl rand -hex 32)"
    echo "[OK] Generated $token_name"
  fi

  printf -v "$output_var" '%s' "$selected_value"
}

# --------------------------------------------------
# Check for Docker
# --------------------------------------------------
if command -v docker &>/dev/null; then
  DOCKER_VERSION=$(docker --version | head -1)
  echo "[OK] $DOCKER_VERSION"
else
  echo "[ERROR] Docker is not installed."
  echo "  Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

# --------------------------------------------------
# Check for Docker Compose
# --------------------------------------------------
if docker compose version &>/dev/null 2>&1; then
  COMPOSE_VERSION=$(docker compose version --short 2>/dev/null || docker compose version)
  echo "[OK] Docker Compose $COMPOSE_VERSION"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_VERSION=$(docker-compose --version | head -1)
  echo "[OK] $COMPOSE_VERSION"
else
  echo "[ERROR] Docker Compose is not installed."
  echo "  Install Docker Compose: https://docs.docker.com/compose/install/"
  exit 1
fi

# --------------------------------------------------
# Ask for ports
# --------------------------------------------------
echo ""
echo "--- Port Configuration ---"

DEFAULT_APP_PORT="${APP_PORT:-3000}"
read -r -p "Client port [$DEFAULT_APP_PORT]: " APP_PORT_INPUT
APP_PORT=${APP_PORT_INPUT:-$DEFAULT_APP_PORT}

DEFAULT_API_PORT="${API_PORT:-3001}"
read -r -p "API/Server port [$DEFAULT_API_PORT]: " API_PORT_INPUT
API_PORT=${API_PORT_INPUT:-$DEFAULT_API_PORT}

DEFAULT_MONGO_PORT="${MONGO_PORT:-27017}"
read -r -p "MongoDB port [$DEFAULT_MONGO_PORT]: " MONGO_PORT_INPUT
MONGO_PORT=${MONGO_PORT_INPUT:-$DEFAULT_MONGO_PORT}

DEFAULT_REDIS_PORT="${REDIS_PORT:-6379}"
read -r -p "Redis port [$DEFAULT_REDIS_PORT]: " REDIS_PORT_INPUT
REDIS_PORT=${REDIS_PORT_INPUT:-$DEFAULT_REDIS_PORT}

# --------------------------------------------------
# Ask for MAIL_URL
# --------------------------------------------------
echo ""
echo "--- Email Configuration ---"
echo "  MAIL_URL is required for email verification and password reset."
echo "  Format: smtp://user:password@smtp.example.com:587"
echo "  Leave blank to skip (emails will not be sent until configured)."
DEFAULT_MAIL_URL="${MAIL_URL:-}"
read -r -p "MAIL_URL [$DEFAULT_MAIL_URL]: " MAIL_URL_INPUT
MAIL_URL=${MAIL_URL_INPUT:-$DEFAULT_MAIL_URL}
if [ -z "$MAIL_URL" ]; then
  echo "[WARN] MAIL_URL not set — email features (verification, password reset) will not work."
  echo "       Set MAIL_URL in the .env file later to enable email."
fi

# --------------------------------------------------
# Generate .env file for Docker Compose
# --------------------------------------------------
echo ""
echo "--- Generating .env file ---"

if ! command -v openssl &>/dev/null; then
  echo "[ERROR] openssl is required to generate JWT secrets but was not found."
  echo "  Install it (e.g., sudo apt-get install openssl) and re-run."
  exit 1
fi

echo "--- JWT Secret Configuration ---"
choose_token_value "JWT_SECRET" "${JWT_SECRET:-}" JWT_SECRET
choose_token_value "JWT_REFRESH_SECRET" "${JWT_REFRESH_SECRET:-}" JWT_REFRESH_SECRET

cat > "$PROJECT_ROOT/.env" <<EOF
# Docker Compose Environment
APP_PORT=$APP_PORT
API_PORT=$API_PORT
MONGO_PORT=$MONGO_PORT
REDIS_PORT=$REDIS_PORT

# Server
APP_VERSION=$APP_VERSION
JWT_SECRET=$JWT_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET
ROOT_URL=http://localhost:$APP_PORT
MAIL_URL=$MAIL_URL
NODE_ENV=production
EOF

echo "[OK] .env file generated at $PROJECT_ROOT/.env"

# --------------------------------------------------
# Optionally build images
# --------------------------------------------------
echo ""
read -r -p "Build Docker images now? [y/N] " BUILD_NOW
if [[ "$BUILD_NOW" =~ ^[Yy]$ ]]; then
  echo "Building images..."
  (cd "$PROJECT_ROOT" && docker compose build)
  echo "[OK] Images built successfully"
fi

# --------------------------------------------------
# Instructions
# --------------------------------------------------
echo ""
echo "======================================"
echo "  Docker Setup Complete!"
echo "======================================"
echo ""
echo "  .env file: $PROJECT_ROOT/.env"
echo ""
echo "  Start all services:"
echo "    docker compose up -d"
echo ""
echo "  Stop all services:"
echo "    docker compose down"
echo ""
echo "  View logs:"
echo "    docker compose logs -f"
echo ""
echo "  Seed the database:"
echo "    ./scripts/seed-db-docker.sh"
echo ""
echo "  Run E2E tests:"
echo "    ./scripts/qlicker.sh e2e --install-browser"
echo ""
echo "  Endpoints:"
echo "    Client:  http://localhost:$APP_PORT"
echo "    API:     http://localhost:$API_PORT"
echo "    MongoDB: localhost:$MONGO_PORT"
echo "    Redis:   localhost:$REDIS_PORT"
echo ""
echo "  Production (with load balancing):"
echo "    See production_setup/README.md for image builds, TLS, and deployment."
echo ""
