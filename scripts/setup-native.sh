#!/bin/bash
set -e

echo "======================================"
echo "  Qlicker - Native Setup Script"
echo "======================================"
echo ""

ERRORS=()
WARNINGS=()

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EXISTING_ENV_FILE="$PROJECT_ROOT/.env"

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
# Check Node.js >= 22.13
# --------------------------------------------------
NODE_REQUIRED_VERSION="22.13.0"
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//')
  if [ "$(printf '%s\n' "$NODE_REQUIRED_VERSION" "$NODE_VERSION" | sort -V | head -n 1)" = "$NODE_REQUIRED_VERSION" ]; then
    echo "[OK] Node.js $NODE_VERSION"
  else
    ERRORS+=("Node.js >= $NODE_REQUIRED_VERSION required (found $NODE_VERSION)")
  fi
else
  ERRORS+=("Node.js not found")
fi

# --------------------------------------------------
# Check npm >= 10
# --------------------------------------------------
if command -v npm &>/dev/null; then
  NPM_VERSION=$(npm -v)
  NPM_MAJOR=$(echo "$NPM_VERSION" | cut -d. -f1)
  if [ "$NPM_MAJOR" -ge 10 ]; then
    echo "[OK] npm $NPM_VERSION"
  else
    ERRORS+=("npm >= 10 required (found $NPM_VERSION)")
  fi
else
  ERRORS+=("npm not found")
fi

# --------------------------------------------------
# Check MongoDB (mongod or mongosh)
# --------------------------------------------------
MONGO_FOUND=false
if command -v mongod &>/dev/null; then
  echo "[OK] mongod found"
  MONGO_FOUND=true
elif command -v mongosh &>/dev/null; then
  echo "[OK] mongosh found"
  MONGO_FOUND=true
else
  WARNINGS+=("MongoDB not found (mongod or mongosh). You can install it or use Docker instead.")
fi

# --------------------------------------------------
# Offer to install missing dependencies (Debian/Ubuntu)
# --------------------------------------------------
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "Missing dependencies:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done

  if [ -f /etc/debian_version ]; then
    echo ""
    read -r -p "Attempt to install missing dependencies via apt-get? [y/N] " INSTALL_DEPS
    if [[ "$INSTALL_DEPS" =~ ^[Yy]$ ]]; then
      echo "Updating package list..."
      sudo apt-get update -qq

      if ! command -v node &>/dev/null || [ "$(printf '%s\n' "$NODE_REQUIRED_VERSION" "$NODE_VERSION" | sort -V | head -n 1)" != "$NODE_REQUIRED_VERSION" ]; then
        echo "Installing Node.js 22..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
      fi

      if ! command -v mongod &>/dev/null && ! command -v mongosh &>/dev/null; then
        echo "Installing mongosh..."
        sudo apt-get install -y mongosh 2>/dev/null || echo "  mongosh not available in default repos. Install MongoDB manually."
      fi
    fi
  else
    echo ""
    echo "Automatic installation is only supported on Debian/Ubuntu."
    echo "Please install the missing dependencies manually and re-run this script."
    exit 1
  fi
fi

# --------------------------------------------------
# Ask for ports
# --------------------------------------------------
echo ""
echo "--- Port Configuration ---"

DEFAULT_APP_PORT="${APP_PORT:-3000}"
read -r -p "Client port [$DEFAULT_APP_PORT]: " APP_PORT_INPUT
APP_PORT=${APP_PORT_INPUT:-$DEFAULT_APP_PORT}

# Check for openssl (needed for secret generation)
if ! command -v openssl &>/dev/null; then
  echo "[ERROR] openssl is required to generate JWT secrets but was not found."
  echo "  Install it (e.g., sudo apt-get install openssl) and re-run."
  exit 1
fi

DEFAULT_API_PORT="${API_PORT:-3001}"
read -r -p "API/Server port [$DEFAULT_API_PORT]: " API_PORT_INPUT
API_PORT=${API_PORT_INPUT:-$DEFAULT_API_PORT}

DEFAULT_MONGO_PORT="${MONGO_PORT:-27017}"
read -r -p "MongoDB port [$DEFAULT_MONGO_PORT]: " MONGO_PORT_INPUT
MONGO_PORT=${MONGO_PORT_INPUT:-$DEFAULT_MONGO_PORT}

# Check if ports are free
check_port() {
  local PORT=$1
  local NAME=$2
  if command -v lsof &>/dev/null; then
    if lsof -iTCP:"$PORT" -sTCP:LISTEN -t &>/dev/null; then
      echo "[WARN] Port $PORT ($NAME) is already in use"
    else
      echo "[OK] Port $PORT ($NAME) is available"
    fi
  elif command -v ss &>/dev/null; then
    if ss -tlnp | grep -q ":$PORT "; then
      echo "[WARN] Port $PORT ($NAME) is already in use"
    else
      echo "[OK] Port $PORT ($NAME) is available"
    fi
  fi
}

check_port "$APP_PORT" "Client"
check_port "$API_PORT" "Server"
check_port "$MONGO_PORT" "MongoDB"

# --------------------------------------------------
# Ask for MongoDB data path
# --------------------------------------------------
echo ""
echo "--- MongoDB Data Path ---"
DEFAULT_MONGO_DBPATH="${MONGO_DBPATH:-data/db}"
read -r -p "MongoDB dbpath [$DEFAULT_MONGO_DBPATH]: " MONGO_DBPATH_INPUT
MONGO_DBPATH=${MONGO_DBPATH_INPUT:-$DEFAULT_MONGO_DBPATH}

if [[ "$MONGO_DBPATH" = /* ]]; then
  MONGO_DBPATH_RESOLVED="$MONGO_DBPATH"
else
  MONGO_DBPATH_RESOLVED="$PROJECT_ROOT/$MONGO_DBPATH"
fi
mkdir -p "$MONGO_DBPATH_RESOLVED"
echo "[OK] MongoDB dbpath: $MONGO_DBPATH_RESOLVED"

# --------------------------------------------------
# Ask for Redis
# --------------------------------------------------
echo ""
echo "--- Redis Configuration (optional) ---"
echo "  Redis enables multi-instance WebSocket pub/sub."
echo "  Leave the URL blank to skip (single-instance mode)."
DEFAULT_REDIS_PORT="${REDIS_PORT:-6379}"
read -r -p "Redis port [$DEFAULT_REDIS_PORT]: " REDIS_PORT_INPUT
REDIS_PORT=${REDIS_PORT_INPUT:-$DEFAULT_REDIS_PORT}
check_port "$REDIS_PORT" "Redis"

DEFAULT_REDIS_URL="${REDIS_URL:-}"
read -r -p "REDIS_URL [redis://localhost:$REDIS_PORT]: " REDIS_URL_INPUT
if [ -z "$REDIS_URL_INPUT" ] && [ -z "$DEFAULT_REDIS_URL" ]; then
  REDIS_URL="redis://localhost:$REDIS_PORT"
else
  REDIS_URL="${REDIS_URL_INPUT:-$DEFAULT_REDIS_URL}"
fi
echo "[OK] REDIS_URL=$REDIS_URL"

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
# Configure host test storage
# --------------------------------------------------
source "$SCRIPT_DIR/setup-test-tmpdir.sh"
configure_test_tmpdir

# --------------------------------------------------
# Generate .env file
# --------------------------------------------------
echo ""
echo "--- Generating .env file ---"

echo "--- JWT Secret Configuration ---"
choose_token_value "JWT_SECRET" "${JWT_SECRET:-}" JWT_SECRET
choose_token_value "JWT_REFRESH_SECRET" "${JWT_REFRESH_SECRET:-}" JWT_REFRESH_SECRET

cat > "$PROJECT_ROOT/.env" <<EOF
# Server
PORT=$API_PORT
HOST=0.0.0.0
MONGO_URI=mongodb://localhost:$MONGO_PORT/qlicker
JWT_SECRET=$JWT_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET
ROOT_URL=http://localhost:$APP_PORT
MAIL_URL=$MAIL_URL
NODE_ENV=development

# Host tests only (empty uses the OS temporary directory)
TEST_TMPDIR="$TEST_TMPDIR"

# Client
VITE_API_URL=http://localhost:$API_PORT
VITE_WS_URL=ws://localhost:$API_PORT

# Ports (used by scripts)
APP_PORT=$APP_PORT
API_PORT=$API_PORT
MONGO_PORT=$MONGO_PORT
MONGO_DBPATH=$MONGO_DBPATH
REDIS_PORT=$REDIS_PORT

# Redis (optional — enables multi-instance WebSocket pub/sub)
REDIS_URL=$REDIS_URL

# Native system monitor (Linux; managed by qlicker.sh)
SYSTEM_MONITOR_ENABLED=${SYSTEM_MONITOR_ENABLED:-true}
SYSTEM_MONITOR_SAMPLE_INTERVAL_SECONDS=${SYSTEM_MONITOR_SAMPLE_INTERVAL_SECONDS:-60}
SYSTEM_MONITOR_ACTIVE_WINDOW_MINUTES=${SYSTEM_MONITOR_ACTIVE_WINDOW_MINUTES:-15}
SYSTEM_MONITOR_NETWORK_INTERFACES=${SYSTEM_MONITOR_NETWORK_INTERFACES:-}
SYSTEM_MONITOR_LOG_PATH=${SYSTEM_MONITOR_LOG_PATH:-.data/system-monitor.log}

EOF

echo "[OK] .env file generated at $PROJECT_ROOT/.env"

# --------------------------------------------------
# Install npm dependencies
# --------------------------------------------------
echo ""
echo "--- Installing dependencies ---"

echo "Installing server dependencies..."
(cd "$PROJECT_ROOT/server" && npm install)

echo "Installing client dependencies..."
(cd "$PROJECT_ROOT/client" && npm install)

# --------------------------------------------------
# Summary
# --------------------------------------------------
echo ""
echo "======================================"
echo "  Setup Complete!"
echo "======================================"
echo ""
echo "  Client URL:   http://localhost:$APP_PORT"
echo "  API URL:      http://localhost:$API_PORT"
echo "  MongoDB:      mongodb://localhost:$MONGO_PORT/qlicker"
echo ""
echo "  .env file:    $PROJECT_ROOT/.env"
echo ""
if [ ${#WARNINGS[@]} -gt 0 ]; then
  echo "  Warnings:"
  for w in "${WARNINGS[@]}"; do
    echo "    - $w"
  done
  echo ""
fi
echo "  Next steps:"
echo "    1. Start MongoDB:  mongod --port $MONGO_PORT --dbpath $MONGO_DBPATH_RESOLVED"
echo "    2. Start Redis:    redis-server --port $REDIS_PORT  (optional)"
echo "    3. Seed database:  ./scripts/seed-db.sh"
echo "    4. Start Qlicker:  ./scripts/qlicker.sh start"
echo "    5. Run E2E tests: ./scripts/qlicker.sh e2e --install-browser"
echo ""
