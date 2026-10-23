#!/usr/bin/env bash
# =============================================================================
# setup.sh — Interactive configuration for the Qlicker load-testing stack.
#
# Supports:
#   • production Docker deployments (production_setup/)
#   • development Docker deployments (repo-root docker-compose.yml)
#   • development native deployments (repo-root .env + local server/client)
#
# Usage:
#   ./setup.sh
#   ./setup.sh --non-interactive
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$SCRIPT_DIR/.env"
DEFAULT_SEED_IMAGE="qlicker-load-testing-seed:local"
SEED_FINGERPRINT_LABEL="org.qlicker.load-testing.seed-fingerprint"
COMMON_SH="$SCRIPT_DIR/common.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
ask()   { echo -en "${CYAN}$1${NC}"; }

# shellcheck disable=SC1091
source "$COMMON_SH"

NON_INTERACTIVE=false
if [[ "${1:-}" == "--non-interactive" ]]; then
  NON_INTERACTIVE=true
fi

existing_val() {
  if [[ -f "$ENV_FILE" ]]; then
    grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//'
  fi
}

default_env_file_guess() {
  local target_env="$1"
  if [[ "$target_env" == "dev" ]]; then
    printf '%s/.env\n' "$PROJECT_ROOT"
  else
    printf '%s/production_setup/.env\n' "$PROJECT_ROOT"
  fi
}

prompt_choice() {
  local label="$1"
  local current="$2"
  local first="$3"
  local second="$4"
  local answer=""

  while true; do
    printf '%b' "${CYAN}${label} [${current}]: ${NC}" >&2
    read -r answer
    answer="${answer:-$current}"
    case "$answer" in
      "$first"|"$second")
        printf '%s\n' "$answer"
        return 0
        ;;
      *)
        warn "Please enter '$first' or '$second'." >&2
        ;;
    esac
  done
}


if ! command -v docker >/dev/null 2>&1; then
  error "Docker is required for the load-test seed and k6 runners."
  exit 1
fi

DEFAULT_TARGET_ENV="$(existing_val TARGET_ENV)"
: "${DEFAULT_TARGET_ENV:=prod}"
DEFAULT_RUNTIME="$(existing_val TARGET_RUNTIME)"
: "${DEFAULT_RUNTIME:=docker}"
DEFAULT_TARGET_ENV_FILE="$(existing_val TARGET_ENV_FILE)"
DEFAULT_STUDENTS="$(existing_val NUM_STUDENTS)"
: "${DEFAULT_STUDENTS:=500}"
DEFAULT_K6_NOFILE_LIMIT="$(existing_val K6_NOFILE_LIMIT)"
: "${DEFAULT_K6_NOFILE_LIMIT:=16384}"
DEFAULT_SEED_IMAGE_TAG="$(existing_val SEED_IMAGE)"
: "${DEFAULT_SEED_IMAGE_TAG:=$DEFAULT_SEED_IMAGE}"

echo ""
info "Qlicker Load Testing — Setup"
echo  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if $NON_INTERACTIVE; then
  TARGET_ENV="${DEFAULT_TARGET_ENV:?TARGET_ENV must be set in load-testing/.env for --non-interactive}"
else
  TARGET_ENV="$(prompt_choice "Target environment (dev or prod)" "$DEFAULT_TARGET_ENV" "dev" "prod")"
fi

if $NON_INTERACTIVE; then
  TARGET_RUNTIME="${DEFAULT_RUNTIME:?TARGET_RUNTIME must be set in load-testing/.env for --non-interactive}"
else
  TARGET_RUNTIME="$(prompt_choice "Runtime for the running stack (docker or native)" "$DEFAULT_RUNTIME" "docker" "native")"
fi

case "$TARGET_ENV" in dev|prod) ;; *) error "TARGET_ENV must be dev or prod"; exit 1 ;; esac
case "$TARGET_RUNTIME" in docker|native) ;; *) error "TARGET_RUNTIME must be docker or native"; exit 1 ;; esac
if [[ "$TARGET_RUNTIME" == "docker" ]] && ! docker compose version >/dev/null 2>&1; then
  error "Docker Compose is required when the target stack is running in Docker."
  exit 1
fi

if [[ -z "$DEFAULT_TARGET_ENV_FILE" || "$(existing_val TARGET_ENV)" != "$TARGET_ENV" ]]; then
  DEFAULT_TARGET_ENV_FILE="$(default_env_file_guess "$TARGET_ENV")"
fi

if $NON_INTERACTIVE; then
  TARGET_ENV_FILE="${DEFAULT_TARGET_ENV_FILE:?TARGET_ENV_FILE must be set in load-testing/.env for --non-interactive}"
else
  ask "Path to the running stack .env file [$DEFAULT_TARGET_ENV_FILE]: "
  read -r TARGET_ENV_FILE
  TARGET_ENV_FILE="${TARGET_ENV_FILE:-$DEFAULT_TARGET_ENV_FILE}"
fi

TARGET_ENV_FILE="$(resolve_abs_path "$TARGET_ENV_FILE")" || {
  error "Could not resolve .env path: $TARGET_ENV_FILE"
  exit 1
}

if [[ ! -f "$TARGET_ENV_FILE" ]]; then
  error "Target .env not found: $TARGET_ENV_FILE"
  exit 1
fi

STACK_DIR="$(dirname "$TARGET_ENV_FILE")"
TARGET_COMPOSE_FILE=""
if [[ "$TARGET_RUNTIME" == "docker" ]]; then
  TARGET_COMPOSE_FILE="$STACK_DIR/docker-compose.yml"
  if [[ ! -f "$TARGET_COMPOSE_FILE" ]]; then
    error "No docker-compose.yml found beside $TARGET_ENV_FILE"
    exit 1
  fi
fi

RESOLVED_BASE_URL="$(resolve_base_url "$TARGET_ENV" "$TARGET_ENV_FILE" || true)"
if [[ -z "$RESOLVED_BASE_URL" ]]; then
  error "Could not determine BASE_URL from $TARGET_ENV_FILE"
  error "Expected VITE_API_URL / API_PORT for dev, or ROOT_URL / DOMAIN for prod."
  exit 1
fi

RESOLVED_MONGO_URL="$(resolve_mongo_url "$TARGET_ENV_FILE" || true)"
if [[ -z "$RESOLVED_MONGO_URL" ]]; then
  error "Could not determine MongoDB connection information from $TARGET_ENV_FILE"
  error "Expected MONGO_URI, MONGO_URL, or MONGO_PORT."
  exit 1
fi

DEFAULT_NETWORK="$(existing_val QLICKER_NETWORK)"
DETECTED_NETWORK=""
if [[ "$TARGET_RUNTIME" == "docker" ]]; then
  DETECTED_NETWORK="$(detect_docker_network "$STACK_DIR" "$TARGET_ENV_FILE" "$TARGET_COMPOSE_FILE" || true)"
  if [[ -n "$DETECTED_NETWORK" ]]; then
    info "Detected Docker network: $DETECTED_NETWORK"
  fi
fi

if [[ "$TARGET_ENV" == "dev" ]]; then
  DEFAULT_NETWORK="$DETECTED_NETWORK"
fi

if [[ -z "$DEFAULT_NETWORK" && -n "$DETECTED_NETWORK" ]]; then
  DEFAULT_NETWORK="$DETECTED_NETWORK"
fi

QLICKER_NETWORK="${DEFAULT_NETWORK:-}"
if [[ "$TARGET_RUNTIME" == "docker" && "$TARGET_ENV" != "dev" ]]; then
  if $NON_INTERACTIVE; then
    : "${QLICKER_NETWORK:?QLICKER_NETWORK must be set for docker/prod in load-testing/.env}"
  else
    ask "Docker network for the running stack [${QLICKER_NETWORK:-auto-detect failed}]: "
    read -r NETWORK_INPUT
    QLICKER_NETWORK="${NETWORK_INPUT:-$QLICKER_NETWORK}"
  fi
fi

if ! $NON_INTERACTIVE; then
  ask "Base URL for the load test [$RESOLVED_BASE_URL]: "
  read -r BASE_URL_INPUT
  RESOLVED_BASE_URL="${BASE_URL_INPUT:-$RESOLVED_BASE_URL}"

  ask "MongoDB URL for the seed script [derived from stack env; Enter to keep]: "
  read -r MONGO_URL_INPUT
  RESOLVED_MONGO_URL="${MONGO_URL_INPUT:-$RESOLVED_MONGO_URL}"

  ask "Number of students to simulate [$DEFAULT_STUDENTS]: "
  read -r NUM_STUDENTS_INPUT
  NUM_STUDENTS="${NUM_STUDENTS_INPUT:-$DEFAULT_STUDENTS}"
else
  NUM_STUDENTS="$DEFAULT_STUDENTS"
fi

if [[ "$TARGET_RUNTIME" == "docker" && -n "$QLICKER_NETWORK" ]]; then
  if docker network inspect "$QLICKER_NETWORK" >/dev/null 2>&1; then
    info "Network '$QLICKER_NETWORK' exists ✓"
  else
    warn "Network '$QLICKER_NETWORK' does not exist yet."
    warn "If the stack is not running, start it before seeding."
  fi
fi

cat > "$ENV_FILE" <<EOF
# =============================================================================
# Qlicker Load Testing — Environment Configuration
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# =============================================================================

TARGET_ENV="$TARGET_ENV"
TARGET_RUNTIME="$TARGET_RUNTIME"
TARGET_ENV_FILE="$TARGET_ENV_FILE"
STACK_DIR="$STACK_DIR"
TARGET_COMPOSE_FILE="$TARGET_COMPOSE_FILE"

# Docker network for stack-internal services (required for docker/prod)
QLICKER_NETWORK="$QLICKER_NETWORK"

# MongoDB connection used by the seed/cleanup runner
MONGO_URL="$RESOLVED_MONGO_URL"

# Target origin for k6 (/api/v1 and /ws live under this URL)
BASE_URL="$RESOLVED_BASE_URL"

# Number of simulated students (override with ./run.sh --students N)
NUM_STUDENTS="$NUM_STUDENTS"

# File-descriptor budget for the k6 container. WebSockets and concurrent HTTP
# connections each consume descriptors; the image default of 1024 is too low
# for the default 500-student classroom scenario.
K6_NOFILE_LIMIT="$DEFAULT_K6_NOFILE_LIMIT"

# Docker image tag used for the seed runner
SEED_IMAGE="$DEFAULT_SEED_IMAGE_TAG"
EOF

info "Configuration written to $ENV_FILE"

echo ""
info "Building the seed Docker image ($DEFAULT_SEED_IMAGE_TAG) …"
docker build \
  --label "$SEED_FINGERPRINT_LABEL=$(seed_image_fingerprint "$SCRIPT_DIR")" \
  -t "$DEFAULT_SEED_IMAGE_TAG" \
  -f "$SCRIPT_DIR/Dockerfile.seed" \
  "$SCRIPT_DIR"
info "Seed image built ✓"

mkdir -p "$SCRIPT_DIR/state" "$SCRIPT_DIR/results"

echo ""
echo  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
info "Setup complete!"
echo ""
echo "  Target environment: $TARGET_ENV"
echo "  Runtime:            $TARGET_RUNTIME"
echo "  Stack env file:     $TARGET_ENV_FILE"
echo "  Base URL:           $RESOLVED_BASE_URL"
echo "  MongoDB connection: configured in load-testing/.env"
if [[ -n "$QLICKER_NETWORK" ]]; then
  echo "  Docker network:     $QLICKER_NETWORK"
fi
echo ""
echo "  Next steps:"
echo ""
echo "  1. Prepare the running stack for load testing:"
echo ""
echo "       ./run.sh --prepare"
if [[ "$TARGET_RUNTIME" == "native" ]]; then
  echo ""
  echo "     Native note: restart the server after --prepare so DISABLE_RATE_LIMITS takes effect."
fi
echo ""
echo "  2. Run the load test:"
echo ""
echo "       ./run.sh"
echo ""
echo "  3. Restore rate limits when finished:"
echo ""
echo "       ./run.sh --restore"
echo ""
echo "  4. Clean up load-test data:"
echo ""
echo "       ./run.sh --clean"
echo ""
echo  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
