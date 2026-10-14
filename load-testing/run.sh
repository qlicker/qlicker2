#!/usr/bin/env bash
# =============================================================================
# run.sh — Qlicker load-test runner.
#
# Commands:
#   ./run.sh                     Seed the database + run the k6 load test
#   ./run.sh --ordinary          Test ordinary sessions with automatic cleanup
#   ./run.sh --matrix            Run the full shared/anonymous comparison
#   ./run.sh --live-stats on|off  Override statistics during answers
#   ./run.sh --students N        Override the configured number of students
#   ./run.sh --enrolled-percent N Set enrolled share for external activities (0–100)
#   ./run.sh --scenario NAME      Choose a live or quiz workload
#   ./run.sh --session-chat MODE Run with session chat enabled or disabled
#   ./run.sh --seed-only         Seed without running k6
#   ./run.sh --test-only         Run k6 without reseeding
#   ./run.sh --clean             Remove load-test seed data from MongoDB
#   ./run.sh --prepare           Disable rate limits on the running stack
#   ./run.sh --restore           Re-enable rate limits on the running stack
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
RESULTS_DIR="$SCRIPT_DIR/results"
STATE_DIR="$SCRIPT_DIR/state"
K6_IMAGE="${K6_IMAGE:-grafana/k6:latest}"
K6_NOFILE_LIMIT="${K6_NOFILE_LIMIT:-16384}"
DEFAULT_SEED_IMAGE="qlicker-load-testing-seed:local"
SEED_FINGERPRINT_LABEL="org.qlicker.load-testing.seed-fingerprint"
COMMON_SH="$SCRIPT_DIR/common.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# shellcheck disable=SC1091
source "$COMMON_SH"

if [[ ! -f "$ENV_FILE" ]]; then
  error ".env not found. Run ./setup.sh first."
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Backward compatibility with the original production-only config.
if [[ -z "${TARGET_ENV:-}" && -n "${QLICKER_STACK_DIR:-}" ]]; then
  TARGET_ENV="prod"
  TARGET_RUNTIME="docker"
  TARGET_ENV_FILE="${TARGET_ENV_FILE:-$QLICKER_STACK_DIR/.env}"
  STACK_DIR="${STACK_DIR:-$QLICKER_STACK_DIR}"
  TARGET_COMPOSE_FILE="${TARGET_COMPOSE_FILE:-$QLICKER_STACK_DIR/docker-compose.yml}"
fi

TARGET_ENV="${TARGET_ENV:-prod}"
TARGET_RUNTIME="${TARGET_RUNTIME:-docker}"
TARGET_ENV_FILE="${TARGET_ENV_FILE:-}"
STACK_DIR="${STACK_DIR:-}"
TARGET_COMPOSE_FILE="${TARGET_COMPOSE_FILE:-}"
QLICKER_NETWORK="${QLICKER_NETWORK:-}"
MONGO_URL="${MONGO_URL:-}"
BASE_URL="${BASE_URL:-}"
NUM_STUDENTS="${NUM_STUDENTS:-500}"
SEED_IMAGE="${SEED_IMAGE:-$DEFAULT_SEED_IMAGE}"
SESSION_CHAT_ENABLED="${SESSION_CHAT_ENABLED:-}"
ENROLLED_PERCENT="${ENROLLED_PERCENT:-}"
LIVE_STATS_DURING_ANSWERS="${LIVE_STATS_DURING_ANSWERS:-false}"
SCENARIO="${SCENARIO:-live-named}"
RATE_LIMIT_STATE_FILE="$STATE_DIR/rate-limit-restore.env"

remind_restore_on_failure() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$RATE_LIMIT_STATE_FILE" ]]; then
    warn "Load testing stopped while rate limits may be disabled. Run ./run.sh --restore, then ./run.sh --clean."
  fi
}
trap remind_restore_on_failure EXIT

if [[ ! "$K6_NOFILE_LIMIT" =~ ^[0-9]+$ ]] || (( K6_NOFILE_LIMIT < 1024 )); then
  error "K6_NOFILE_LIMIT must be an integer of at least 1024."
  exit 1
fi

if [[ -z "$STACK_DIR" && -n "$TARGET_ENV_FILE" ]]; then
  STACK_DIR="$(dirname "$TARGET_ENV_FILE")"
fi
if [[ -z "$TARGET_COMPOSE_FILE" && "$TARGET_RUNTIME" == "docker" && -n "$STACK_DIR" ]]; then
  TARGET_COMPOSE_FILE="$STACK_DIR/docker-compose.yml"
fi

if [[ -z "$MONGO_URL" || -z "$BASE_URL" ]]; then
  error "MONGO_URL and BASE_URL must be set in $ENV_FILE. Run ./setup.sh again."
  exit 1
fi

ACTION="full"
MATRIX=false
ORDINARY=false
MATRIX_OPTIONS=false
STATS_OPTION=false

normalize_boolean_flag() {
  local value="${1:-}"
  value="${value,,}"
  case "$value" in
    1|true|yes|on|enabled)
      printf 'true\n'
      ;;
    0|false|no|off|disabled)
      printf 'false\n'
      ;;
    *)
      return 1
      ;;
  esac
}

if [[ -n "$SESSION_CHAT_ENABLED" ]] && ! SESSION_CHAT_ENABLED="$(normalize_boolean_flag "$SESSION_CHAT_ENABLED")"; then
  error "SESSION_CHAT_ENABLED must be one of: true/false, on/off, enabled/disabled."
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --students)
      if [[ $# -lt 2 ]]; then error "--students requires a number"; exit 1; fi
      NUM_STUDENTS="$2"; shift 2 ;;
    --matrix)
      MATRIX=true; shift ;;
    --ordinary)
      ORDINARY=true; shift ;;
    --live-stats)
      STATS_OPTION=true
      if [[ $# -lt 2 ]] || ! LIVE_STATS_DURING_ANSWERS="$(normalize_boolean_flag "$2")"; then
        error "--live-stats requires on|off"; exit 1
      fi
      shift 2 ;;
    --enrolled-percent)
      MATRIX_OPTIONS=true
      if [[ $# -lt 2 ]]; then error "--enrolled-percent requires an integer from 0 to 100"; exit 1; fi
      ENROLLED_PERCENT="$2"; shift 2 ;;
    --scenario)
      MATRIX_OPTIONS=true
      if [[ $# -lt 2 ]]; then error "--scenario requires a name"; exit 1; fi
      SCENARIO="$2"; shift 2 ;;
    --session-chat)
      MATRIX_OPTIONS=true
      if [[ $# -lt 2 ]]; then
        error "--session-chat requires a value: on|off"
        exit 1
      fi
      if ! SESSION_CHAT_ENABLED="$(normalize_boolean_flag "$2")"; then
        error "Invalid --session-chat value '$2'. Use on|off, true|false, or enabled|disabled."
        exit 1
      fi
      shift 2 ;;
    --seed-only)
      ACTION="seed-only"; shift ;;
    --test-only)
      ACTION="test-only"; shift ;;
    --clean)
      ACTION="clean"; shift ;;
    --prepare)
      ACTION="prepare"; shift ;;
    --restore)
      ACTION="restore"; shift ;;
    -h|--help)
      head -21 "$0"
      exit 0 ;;
    *)
      error "Unknown option: $1"
      exit 1 ;;
  esac
done

if [[ ! "$NUM_STUDENTS" =~ ^[1-9][0-9]*$ ]]; then
  error "--students must be a positive integer."; exit 1
fi
if [[ "$MATRIX" == true || "$ORDINARY" == true ]]; then
  if [[ "$MATRIX" == true && "$ORDINARY" == true ]]; then
    error "Choose --ordinary or --matrix, not both."; exit 1
  fi
  if [[ "$ACTION" != full || "$MATRIX_OPTIONS" == true || ( "$MATRIX" == true && "$STATS_OPTION" == true ) ]]; then
    error "--ordinary accepts --students and optional --live-stats on|off; --matrix accepts only --students."; exit 1
  fi
  if [[ "$TARGET_RUNTIME" != docker || "$TARGET_ENV" != prod ]]; then
    error "Automatic comparisons require the production-equivalent prod/docker configuration."; exit 1
  fi
  profile=matrix
  stats_mode=both
  if [[ "$ORDINARY" == true ]]; then
    profile=ordinary
    if [[ "$STATS_OPTION" == true ]]; then
      if [[ "$LIVE_STATS_DURING_ANSWERS" == true ]]; then stats_mode=on; else stats_mode=off; fi
    fi
  fi
  export STACK_DIR TARGET_ENV_FILE TARGET_COMPOSE_FILE K6_IMAGE
  exec bash "$SCRIPT_DIR/matrix.sh" --students "$NUM_STUDENTS" --profile "$profile" --stats "$stats_mode"
fi

case "$SCENARIO" in
  live-named|live-anonymous|live-external-named|live-external-anonymous) SCENARIO_FILE="live-session.js" ;;
  quiz-named|quiz-anonymous|quiz-external-named|quiz-external-anonymous) SCENARIO_FILE="quiz-session.js" ;;
  *) error "Unknown scenario '$SCENARIO'. Use live-named, live-anonymous, quiz-named, quiz-anonymous, or their live/quiz external named/anonymous variants."; exit 1 ;;
esac

if [[ -z "$SESSION_CHAT_ENABLED" ]]; then
  if [[ "$SCENARIO" == "live-named" ]]; then SESSION_CHAT_ENABLED=true; else SESSION_CHAT_ENABLED=false; fi
fi
if [[ "$SCENARIO" == live-* && "$SCENARIO" != "live-named" && "$SESSION_CHAT_ENABLED" == true ]]; then
  error "Shared and anonymous live comparisons require --session-chat off. Use the same setting for the baseline."
  exit 1
fi
if ! LIVE_STATS_DURING_ANSWERS="$(normalize_boolean_flag "$LIVE_STATS_DURING_ANSWERS")"; then
  error "LIVE_STATS_DURING_ANSWERS must be true or false."
  exit 1
fi
if [[ -z "$ENROLLED_PERCENT" ]]; then
  case "$SCENARIO" in
    *-external-named) ENROLLED_PERCENT=50 ;;
    *-external-anonymous) ENROLLED_PERCENT=0 ;;
    *) ENROLLED_PERCENT=100 ;;
  esac
fi
if [[ ! "$ENROLLED_PERCENT" =~ ^(0|[1-9][0-9]?|100)$ ]]; then
  error "--enrolled-percent must be an integer from 0 to 100."
  exit 1
fi
if [[ "$SCENARIO" != *-external-* && "$ENROLLED_PERCENT" != 100 ]]; then
  error "Only external scenarios support guests; use --enrolled-percent 100 for ordinary sessions."
  exit 1
fi
RUN_LABEL="$SCENARIO"
if [[ "$SCENARIO" == *-external-* ]]; then RUN_LABEL="${SCENARIO}-enrolled-${ENROLLED_PERCENT}"; fi
if [[ "$LIVE_STATS_DURING_ANSWERS" == true ]]; then RUN_LABEL="${RUN_LABEL}-live-stats"; fi

is_local_address() {
  local value="$1"
  [[ "$value" == *localhost* || "$value" == *127.0.0.1* || "$value" == *"[::1]"* ]]
}

rewrite_localhost_for_docker() {
  local value="$1"
  value="${value/localhost/host.docker.internal}"
  value="${value/127.0.0.1/host.docker.internal}"
  value="${value/\[::1\]/host.docker.internal}"
  printf '%s\n' "$value"
}

refresh_docker_network() {
  if [[ "$TARGET_RUNTIME" != "docker" ]]; then
    return 0
  fi
  if [[ -z "$STACK_DIR" || -z "$TARGET_ENV_FILE" || -z "$TARGET_COMPOSE_FILE" ]]; then
    return 0
  fi
  if [[ ! -f "$TARGET_ENV_FILE" || ! -f "$TARGET_COMPOSE_FILE" ]]; then
    return 0
  fi

  local detected_network=""
  detected_network="$(detect_docker_network "$STACK_DIR" "$TARGET_ENV_FILE" "$TARGET_COMPOSE_FILE" || true)"
  if [[ -z "$detected_network" ]]; then
    return 0
  fi

  if [[ "$QLICKER_NETWORK" != "$detected_network" ]]; then
    if [[ -n "$QLICKER_NETWORK" ]]; then
      warn "Using detected Docker network '$detected_network' instead of '$QLICKER_NETWORK'."
    else
      info "Detected Docker network: $detected_network"
    fi
    QLICKER_NETWORK="$detected_network"
  fi
}

current_mongo_url() {
  local runtime_mongo_url="$MONGO_URL"
  if [[ -n "$TARGET_ENV_FILE" && -f "$TARGET_ENV_FILE" ]]; then
    local resolved_runtime_mongo_url=""
    resolved_runtime_mongo_url="$(resolve_mongo_url "$TARGET_ENV_FILE" || true)"
    if [[ -n "$resolved_runtime_mongo_url" ]]; then
      runtime_mongo_url="$resolved_runtime_mongo_url"
    fi
  fi
  printf '%s\n' "$runtime_mongo_url"
}

stack_compose() {
  docker compose \
    --project-directory "$STACK_DIR" \
    --env-file "$TARGET_ENV_FILE" \
    -f "$TARGET_COMPOSE_FILE" \
    "$@" </dev/null
}

set_boolean_env_var() {
  local key="$1"
  local value="$2"
  local file_path="$3"

  if [[ ! -f "$file_path" ]]; then
    error "Environment file not found: $file_path"
    exit 1
  fi

  if grep -q "^${key}=" "$file_path" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file_path"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file_path"
  fi
}

check_network_if_needed() {
  refresh_docker_network
  if [[ -n "$QLICKER_NETWORK" ]]; then
    if ! docker network inspect "$QLICKER_NETWORK" >/dev/null 2>&1; then
      error "Docker network '$QLICKER_NETWORK' not found."
      error "Start the target stack before seeding, or re-run ./setup.sh."
      exit 1
    fi
  fi
}

seed_runner() {
  local seed_mongo_url
  seed_mongo_url="$(current_mongo_url)"
  if is_local_address "$seed_mongo_url"; then
    seed_mongo_url="$(rewrite_localhost_for_docker "$seed_mongo_url")"
  fi

  local -a network_args=()
  if [[ -n "$QLICKER_NETWORK" ]]; then
    network_args=(--network "$QLICKER_NETWORK")
  fi

  local -a seed_env=()
  local pass_through_key=""
  for pass_through_key in MONGO_CONNECT_RETRIES MONGO_CONNECT_RETRY_DELAY_MS; do
    if [[ -n "${!pass_through_key:-}" ]]; then
      seed_env+=(-e "$pass_through_key=${!pass_through_key}")
    fi
  done

  docker run --rm \
    "${network_args[@]}" \
    --add-host=host.docker.internal:host-gateway \
    -e MONGO_URL="$seed_mongo_url" \
    "${seed_env[@]}" \
    -e STATE_DIR=/state \
    -v "$STATE_DIR:/state" \
    "$SEED_IMAGE" \
    "$@"
}

k6_runner() {
  local scenario_file="${1:-$SCENARIO_FILE}"
  local -a k6_flags=()
  if [[ "$scenario_file" == "preflight.js" ]]; then
    k6_flags=(--quiet --summary-mode=compact)
  else
    k6_flags=(--summary-export "/results/summary-${RUN_LABEL}-${RUN_TIMESTAMP}.json")
  fi
  local k6_base_url="$BASE_URL"
  if is_local_address "$k6_base_url"; then
    k6_base_url="$(rewrite_localhost_for_docker "$k6_base_url")"
  fi

  local -a network_args=()
  if [[ -n "$QLICKER_NETWORK" ]]; then
    network_args=(--network "$QLICKER_NETWORK")
  fi

  local -a docker_env=()
  local -a k6_env=()
  local pass_through_key=""
  for pass_through_key in \
    SESSION_CHAT_ENABLED \
    ENROLLED_PERCENT \
    LIVE_STATS_DURING_ANSWERS \
    ANSWER_WINDOW_S \
    STATS_PAUSE_S \
    CORRECT_PAUSE_S \
    JOIN_GRACE_S \
    RESPONSE_JITTER_MS \
    RESPONSE_ADDED_REFRESH_MS \
    STUDENT_LOGIN_SPREAD_S \
    CHAT_ACTIVITY_EVERY_N_QUESTIONS \
    CHAT_VIEWER_STUDENT_FRACTION \
    CHAT_QUICK_POST_STUDENT_FRACTION \
    CHAT_RANDOM_POST_STUDENT_FRACTION \
    CHAT_RANDOM_UPVOTE_STUDENT_FRACTION \
    CHAT_ACTION_JITTER_MS \
    CHAT_REPLY_PROFESSOR_LIMIT \
    PROFESSOR_REPLY_DELAY_MS; do
    if [[ -n "${!pass_through_key:-}" ]]; then
      docker_env+=(-e "$pass_through_key=${!pass_through_key}")
      k6_env+=(--env "$pass_through_key=${!pass_through_key}")
    fi
  done

  docker run --rm \
    --name "qlicker-load-${RUN_LABEL}-${RUN_TIMESTAMP}-${scenario_file%.js}" \
    --user "$(id -u):$(id -g)" \
    --ulimit "nofile=${K6_NOFILE_LIMIT}:${K6_NOFILE_LIMIT}" \
    "${network_args[@]}" \
    --add-host=host.docker.internal:host-gateway \
    -e BASE_URL="$k6_base_url" \
    -e STATE_FILE=/state/state.json \
    "${docker_env[@]}" \
    -v "$SCRIPT_DIR/scenarios:/scenarios:ro" \
    -v "$STATE_DIR:/state:ro" \
    -v "$RESULTS_DIR:/results" \
    "$K6_IMAGE" \
    run \
      --env BASE_URL="$k6_base_url" \
      --env STATE_FILE=/state/state.json \
      "${k6_env[@]}" \
      "${k6_flags[@]}" \
      "/scenarios/${scenario_file}"
}

require_seed_image() {
  local expected_fingerprint image_fingerprint
  expected_fingerprint="$(seed_image_fingerprint "$SCRIPT_DIR")"
  image_fingerprint="$(docker image inspect --format "{{ index .Config.Labels \"$SEED_FINGERPRINT_LABEL\" }}" "$SEED_IMAGE" 2>/dev/null || true)"
  if [[ "$image_fingerprint" == "$expected_fingerprint" ]]; then
    return 0
  fi

  info "Seed image '$SEED_IMAGE' is missing or out of date; rebuilding it from this checkout …"
  docker build \
    --label "$SEED_FINGERPRINT_LABEL=$expected_fingerprint" \
    -t "$SEED_IMAGE" \
    -f "$SCRIPT_DIR/Dockerfile.seed" \
    "$SCRIPT_DIR"
  image_fingerprint="$(docker image inspect --format "{{ index .Config.Labels \"$SEED_FINGERPRINT_LABEL\" }}" "$SEED_IMAGE" 2>/dev/null || true)"
  if [[ "$image_fingerprint" != "$expected_fingerprint" ]]; then
    error "The rebuilt seed image does not match this checkout."
    exit 1
  fi
}

do_prepare() {
  if [[ -f "$RATE_LIMIT_STATE_FILE" ]]; then
    error "A rate-limit restore record already exists: $RATE_LIMIT_STATE_FILE. Run --restore first."
    exit 1
  fi
  if [[ "$TARGET_RUNTIME" == "docker" ]]; then
    # Build before changing the stack, so a missing/stale seed image cannot
    # leave rate limits disabled when the load test has not even started.
    require_seed_image
  fi
  if [[ ! -f "$TARGET_ENV_FILE" ]]; then error "Target environment file not found: $TARGET_ENV_FILE"; exit 1; fi
  mkdir -p "$STATE_DIR"
  local existing_line
  existing_line="$(grep -m1 '^DISABLE_RATE_LIMITS=' "$TARGET_ENV_FILE" || true)"
  printf '%s\n' "$existing_line" > "$RATE_LIMIT_STATE_FILE"
  info "Preparing the $TARGET_ENV/$TARGET_RUNTIME stack for load testing …"
  set_boolean_env_var DISABLE_RATE_LIMITS true "$TARGET_ENV_FILE"
  info "Set DISABLE_RATE_LIMITS=true in $TARGET_ENV_FILE"

  if [[ "$TARGET_RUNTIME" == "docker" ]]; then
    if [[ -z "$TARGET_COMPOSE_FILE" || ! -f "$TARGET_COMPOSE_FILE" ]]; then
      error "Docker compose file not found: $TARGET_COMPOSE_FILE"
      exit 1
    fi

    info "Recreating the server service with rate limits disabled …"
    stack_compose up -d server

    if [[ "$TARGET_ENV" == "prod" ]]; then
      info "Disabling nginx limit_req directives …"
      if ! stack_compose exec -T nginx sh -c \
        "sed -i 's/^[[:space:]]*limit_req /#limit_req /g' /etc/nginx/conf.d/default.conf && nginx -s reload" \
        2>/dev/null; then
        error "Could not disable nginx rate limits; run --restore and check the nginx service."
        exit 1
      fi
      if ! stack_compose exec -T nginx sh -c \
        "nginx -T 2>/dev/null | grep -Eq '^[[:space:]]*limit_req[[:space:]]'; test \$? -eq 1"; then
        error "Active Nginx configuration still contains a limit_req rule; run --restore and inspect nginx -T."
        exit 1
      fi
    fi

    info "Prepare complete ✓"
    return 0
  fi

  warn "Native runtime detected."
  warn "Restart the server process to apply DISABLE_RATE_LIMITS=true before running the test."
  if [[ -x "$STACK_DIR/scripts/qlicker.sh" ]]; then
    warn "If you use qlicker.sh: (cd $STACK_DIR && ./scripts/qlicker.sh restart)"
  fi
}

do_restore() {
  if [[ ! -f "$RATE_LIMIT_STATE_FILE" ]]; then
    error "No rate-limit restore record found; the original rate-limit setting is unknown. Check $TARGET_ENV_FILE and the active Nginx config before another load test."
    exit 1
  fi
  info "Restoring rate limits on the $TARGET_ENV/$TARGET_RUNTIME stack …"
  local original_line
  original_line="$(cat "$RATE_LIMIT_STATE_FILE")"
  if [[ -n "$original_line" ]]; then
    if grep -q '^DISABLE_RATE_LIMITS=' "$TARGET_ENV_FILE"; then
      sed -i "s|^DISABLE_RATE_LIMITS=.*|${original_line}|" "$TARGET_ENV_FILE"
    else
      printf '\n%s\n' "$original_line" >> "$TARGET_ENV_FILE"
    fi
  else
    sed -i '/^DISABLE_RATE_LIMITS=/d' "$TARGET_ENV_FILE"
  fi
  info "Restored DISABLE_RATE_LIMITS to its original setting in $TARGET_ENV_FILE"

  if [[ "$TARGET_RUNTIME" == "docker" ]]; then
    if [[ -z "$TARGET_COMPOSE_FILE" || ! -f "$TARGET_COMPOSE_FILE" ]]; then
      error "Docker compose file not found: $TARGET_COMPOSE_FILE"
      exit 1
    fi

    info "Recreating the server service with its original rate-limit setting …"
    stack_compose up -d server

    if [[ "$TARGET_ENV" == "prod" ]]; then
      info "Restarting nginx to restore its rendered rate-limit config …"
      stack_compose restart nginx
    fi

    rm -f "$RATE_LIMIT_STATE_FILE"
    info "Restore complete ✓"
    return 0
  fi

  warn "Native runtime detected."
  rm -f "$RATE_LIMIT_STATE_FILE"
  warn "Restart the server process to apply its original rate-limit setting."
  if [[ -x "$STACK_DIR/scripts/qlicker.sh" ]]; then
    warn "If you use qlicker.sh: (cd $STACK_DIR && ./scripts/qlicker.sh restart)"
  fi
}

do_seed() {
  require_seed_image
  check_network_if_needed
  mkdir -p "$STATE_DIR"

  info "Seeding $SCENARIO with $NUM_STUDENTS students …"
  seed_runner --students "$NUM_STUDENTS" --scenario "$SCENARIO" --enrolled-percent "$ENROLLED_PERCENT"
  info "Seeding complete ✓"

  if [[ ! -f "$STATE_DIR/state.json" ]]; then
    error "state/state.json was not created. Check the seed output above."
    exit 1
  fi

  info "State file: $STATE_DIR/state.json"
}

require_prepared_stack() {
  if [[ "$TARGET_ENV" != "prod" || "$TARGET_RUNTIME" != "docker" ]]; then
    return 0
  fi
  if [[ ! -f "$RATE_LIMIT_STATE_FILE" ]]; then
    error "Production Docker load tests require --prepare before seeding or testing. No restore record exists at $RATE_LIMIT_STATE_FILE."
    error "If DISABLE_RATE_LIMITS is already true, inspect the stack and restore it manually before preparing again."
    return 1
  fi
  if ! grep -qx 'DISABLE_RATE_LIMITS=true' "$TARGET_ENV_FILE"; then
    error "The restore record exists, but DISABLE_RATE_LIMITS=true is missing from $TARGET_ENV_FILE. Run --restore, then --prepare."
    return 1
  fi
}

do_test() {
  require_prepared_stack
  check_network_if_needed
  if [[ ! -f "$STATE_DIR/state.json" ]]; then
    error "state/state.json not found. Run seeding first: ./run.sh --seed-only"
    exit 1
  fi

  local state_scenario
  if ! state_scenario="$(sed -n 's/^[[:space:]]*"scenario": "\([^"]*\)".*/\1/p' "$STATE_DIR/state.json" | head -1)" || [[ "$state_scenario" != "$SCENARIO" ]]; then
    error "The state file does not match scenario '$SCENARIO'. Reseed before testing; the seed image may be stale."
    exit 1
  fi
  if [[ "$SCENARIO" == *-external-* ]]; then
    local state_percent
    state_percent="$(sed -n 's/^[[:space:]]*"enrolledPercent": \([0-9]*\).*/\1/p' "$STATE_DIR/state.json" | head -1)"
    if [[ "$state_percent" != "$ENROLLED_PERCENT" ]]; then
      error "The fixture does not match enrolled percentage $ENROLLED_PERCENT. Reseed with --enrolled-percent $ENROLLED_PERCENT; the seed image may be stale."
      exit 1
    fi
  fi
  mkdir -p "$RESULTS_DIR"
  RUN_TIMESTAMP="$(date +%Y%m%d-%H%M%S-%N)"
  local result_log="$RESULTS_DIR/k6-${RUN_LABEL}-${RUN_TIMESTAMP}.log"
  local session_chat_label="disabled"
  if [[ "$SESSION_CHAT_ENABLED" == "true" ]]; then
    session_chat_label="enabled"
  fi

  info "Checking the public login path before starting $SCENARIO …"
  local preflight_log="$RESULTS_DIR/preflight-${RUN_LABEL}-${RUN_TIMESTAMP}.log"
  if ! k6_runner preflight.js > "$preflight_log" 2>&1; then
    cat "$preflight_log"
    error "Login ingress preflight failed. Check Nginx and any upstream proxy limits before running the load test."
    error "Preflight log: $preflight_log"
    return 10
  fi
  info "Login ingress preflight passed ✓"
  info "Running $SCENARIO load test against $BASE_URL …"
  info "Enrolled participants: ${ENROLLED_PERCENT}%; session chat: $session_chat_label; stats during answers: $LIVE_STATS_DURING_ANSWERS"
  info "Results log: $result_log"
  echo ""

  set +e
  k6_runner 2>&1 | tee "$result_log"
  local k6_exit=${PIPESTATUS[0]}
  set -e

  echo ""
  if [[ $k6_exit -eq 0 ]]; then
    info "Load test PASSED ✓"
  elif (( k6_exit == 141 )); then
    warn "Load test FAILED: k6/container exited with SIGPIPE (141). Inspect the log for the underlying cause."
  else
    warn "Load test FAILED (k6/container exit code $k6_exit). Inspect the log and threshold summary."
  fi
  info "Full log saved to: $result_log"
  local summary_file="$RESULTS_DIR/summary-${RUN_LABEL}-${RUN_TIMESTAMP}.json"
  if [[ -f "$summary_file" ]]; then
    info "Summary saved to: $summary_file"
  else
    warn "No summary file was produced; the k6/container process ended before exporting it."
  fi

  return $k6_exit
}

do_clean() {
  require_seed_image
  check_network_if_needed

  info "Cleaning load-test data from the database …"
  seed_runner --clean
  info "Cleanup complete ✓"

  rm -f "$STATE_DIR/state.json"
}

case "$ACTION" in
  prepare)
    do_prepare
    ;;
  restore)
    do_restore
    ;;
  seed-only)
    do_seed
    ;;
  test-only)
    do_test
    ;;
  clean)
    do_clean
    ;;
  full)
    require_prepared_stack
    do_seed
    echo ""
    TEST_EXIT=0
    do_test || TEST_EXIT=$?
    echo ""
    info "To clean up seed data later:  ./run.sh --clean"
    info "To restore rate limits:       ./run.sh --restore"
    exit "$TEST_EXIT"
    ;;
esac
