#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_ROOT/.qlicker.pids"

# Load .env if present
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env"
  set +a
fi

APP_PORT=${APP_PORT:-3000}
API_PORT=${API_PORT:-3001}
MONGO_PORT=${MONGO_PORT:-27017}
MONGO_DBPATH=${MONGO_DBPATH:-data/db}
MONGO_LOG_PATH=${MONGO_LOG_PATH:-.data/mongodb.log}
REDIS_URL=${REDIS_URL:-}
REDIS_PORT=${REDIS_PORT:-}
if [ -z "$REDIS_PORT" ] && [ -n "$REDIS_URL" ] && [[ "$REDIS_URL" =~ :([0-9]+)(/|$) ]]; then
  REDIS_PORT="${BASH_REMATCH[1]}"
fi
REDIS_PORT=${REDIS_PORT:-6379}
REDIS_PID_PATH=${REDIS_PID_PATH:-.data/redis-$REDIS_PORT.pid}
REDIS_LOG_PATH=${REDIS_LOG_PATH:-.data/redis-$REDIS_PORT.log}
SYSTEM_MONITOR_ENABLED=${SYSTEM_MONITOR_ENABLED:-true}
SYSTEM_MONITOR_LOG_PATH=${SYSTEM_MONITOR_LOG_PATH:-.data/system-monitor.log}
MONITOR_PID_FILE="$PROJECT_ROOT/.data/system-monitor.pid"

resolve_path() {
  local input_path="$1"
  if [[ "$input_path" = /* ]]; then
    printf '%s\n' "$input_path"
  else
    printf '%s\n' "$PROJECT_ROOT/$input_path"
  fi
}

ensure_npm_available() {
  if command -v npm &>/dev/null; then
    return 0
  fi

  echo "  [ERROR] npm is required to install workspace dependencies."
  exit 1
}

workspace_dependencies_need_install() {
  local workspace_dir="$1"
  local package_json="$workspace_dir/package.json"
  local package_lock="$workspace_dir/package-lock.json"
  local node_modules_dir="$workspace_dir/node_modules"
  local hidden_lock="$node_modules_dir/.package-lock.json"

  if [ ! -f "$package_json" ]; then
    return 1
  fi

  if [ ! -d "$node_modules_dir" ]; then
    return 0
  fi

  if [ -f "$package_lock" ] && [ ! -f "$hidden_lock" ]; then
    return 0
  fi

  if [ -f "$hidden_lock" ] && [ "$hidden_lock" -ot "$package_json" ]; then
    return 0
  fi

  if [ -f "$package_lock" ] && [ -f "$hidden_lock" ] && [ "$hidden_lock" -ot "$package_lock" ]; then
    return 0
  fi

  if ! (cd "$workspace_dir" && npm ls --depth=0 >/dev/null 2>&1); then
    return 0
  fi

  return 1
}

ensure_workspace_dependencies() {
  local workspace_dir="$1"
  local workspace_name="$2"

  if workspace_dependencies_need_install "$workspace_dir"; then
    ensure_npm_available
    echo "  Installing $workspace_name dependencies..."
    (cd "$workspace_dir" && npm install --no-fund --no-audit)
    echo "  [OK] $workspace_name dependencies installed"
  else
    echo "  [OK] $workspace_name dependencies are up to date"
  fi
}

find_vite_binary() {
  local candidate
  for candidate in "$PROJECT_ROOT/client/node_modules/.bin/vite" "$PROJECT_ROOT/node_modules/.bin/vite"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

is_port_listening() {
  local port="$1"
  if command -v lsof &>/dev/null; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null
    return $?
  fi

  if command -v ss &>/dev/null; then
    ss -tln | grep -q ":$port "
    return $?
  fi

  return 1
}

listening_pid_for_port() {
  local port="$1"
  if command -v lsof &>/dev/null; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1
    return 0
  fi

  if command -v ss &>/dev/null; then
    ss -ltnp 2>/dev/null | awk -v port="$port" '
      $1 == "LISTEN" && $4 ~ ":" port "$" {
        if (match($0, /pid=([0-9]+)/, matches)) {
          print matches[1]
          exit
        }
      }
    '
    return 0
  fi

  return 1
}

pid_cwd() {
  local pid="$1"
  readlink "/proc/$pid/cwd" 2>/dev/null || true
}

pid_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

wait_for_port() {
  local port="$1"
  local attempts="${2:-40}"
  local delay="${3:-0.25}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if is_port_listening "$port"; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

ensure_port_free() {
  local port="$1"
  local name="$2"
  if is_port_listening "$port"; then
    echo "  [ERROR] $name port $port is already in use."
    return 1
  fi
  return 0
}

is_running_pid() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # Orphaned children may remain zombies until their parent reaps them.
  [[ "$(ps -p "$pid" -o stat= 2>/dev/null)" != *Z* ]]
}

is_qlicker_monitor_pid() {
  local pid="$1" cmd
  is_running_pid "$pid" || return 1
  [ "$(pid_cwd "$pid")" = "$PROJECT_ROOT/server" ] || return 1
  cmd="$(pid_command "$pid")"
  [[ "$cmd" =~ (^|/)node[[:space:]] ]] && [[ " $cmd " == *" src/systemMonitor.js "* ]]
}

stop_qlicker_monitor() {
  local pid="${1:-}"
  if [ -z "$pid" ] && [ -f "$MONITOR_PID_FILE" ]; then
    read -r pid < "$MONITOR_PID_FILE" || true
  fi
  if ! is_qlicker_monitor_pid "$pid"; then
    # A stale PID must never authorize killing a different process.
    if [ -z "${1:-}" ]; then rm -f "$MONITOR_PID_FILE"; fi
    return 1
  fi
  kill_pid_gracefully "$pid" 100
  rm -f "$MONITOR_PID_FILE"
  echo "  [OK] Stopped system-monitor (PID: $pid)"
}

kill_pid_gracefully() {
  local pid="$1"
  local attempts="${2:-20}"
  if ! is_running_pid "$pid"; then
    return 0
  fi

  kill "$pid" 2>/dev/null || true

  local i
  for ((i = 0; i < attempts; i++)); do
    if ! is_running_pid "$pid"; then
      return 0
    fi
    sleep 0.1
  done

  kill -9 "$pid" 2>/dev/null || true
}

cleanup_started_pids() {
  local entries=("$@") pid_entry pid i
  # Stop dependants before their databases, including on startup rollback.
  for ((i = ${#entries[@]} - 1; i >= 0; i--)); do
    pid_entry="${entries[$i]}"
    pid="${pid_entry#*:}"
    kill_pid_gracefully "$pid"
  done
}

stop_orphan_on_port() {
  local port="$1"
  local expected_cwd="$2"
  local name="$3"
  local pid cwd

  pid="$(listening_pid_for_port "$port" || true)"
  if [ -z "$pid" ]; then
    return 1
  fi

  cwd="$(pid_cwd "$pid")"
  if [ "$cwd" != "$expected_cwd" ]; then
    return 1
  fi

  kill_pid_gracefully "$pid"
  echo "  [OK] Stopped orphan $name on port $port (PID: $pid)"
  return 0
}

stop_orphan_qlicker_redis() {
  local pidfile pid cmd

  pidfile="$(resolve_path "$REDIS_PID_PATH")"
  if [ ! -f "$pidfile" ]; then
    return 1
  fi

  pid="$(tr -dc '0-9' < "$pidfile" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    rm -f "$pidfile"
    return 1
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pidfile"
    return 1
  fi

  cmd="$(pid_command "$pid")"
  if [[ "$cmd" != *redis-server* ]]; then
    rm -f "$pidfile"
    return 1
  fi

  if [[ "$cmd" != *":$REDIS_PORT"* && "$cmd" != *"--port $REDIS_PORT"* ]]; then
    echo "  [SKIP] Redis PID file points to redis-server on a different port (PID: $pid)"
    return 1
  fi

  if command -v redis-cli &>/dev/null; then
    redis-cli -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  fi

  kill_pid_gracefully "$pid"
  rm -f "$pidfile"

  if is_port_listening "$REDIS_PORT"; then
    echo "  [WARN] Failed to stop qlicker-managed redis-server on port $REDIS_PORT (PID: $pid)"
    return 1
  fi

  echo "  [OK] Stopped qlicker-managed redis-server on port $REDIS_PORT (PID: $pid)"
  return 0
}

stop_orphaned_services() {
  local found=false

  if stop_qlicker_monitor; then
    found=true
  fi

  if stop_orphan_on_port "$API_PORT" "$PROJECT_ROOT/server" "server"; then
    found=true
  fi

  if stop_orphan_on_port "$APP_PORT" "$PROJECT_ROOT/client" "client"; then
    found=true
  fi

  if stop_orphan_qlicker_redis; then
    found=true
  fi

  if $found; then
    return 0
  fi
  return 1
}

has_running_pids_from_file() {
  local line pid name
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi

  while IFS= read -r line; do
    pid="${line#*:}"
    name="${line%%:*}"
    if [ "$name" = "system-monitor" ]; then
      if is_qlicker_monitor_pid "$pid"; then return 0; fi
    elif is_running_pid "$pid"; then
      return 0
    fi
  done < "$PID_FILE"

  return 1
}

start_system_monitor() {
  if [ "$SYSTEM_MONITOR_ENABLED" = "false" ]; then
    echo "  [SKIP] System monitor disabled by SYSTEM_MONITOR_ENABLED=false"
    return 0
  fi
  if [ "$(uname -s)" != "Linux" ]; then
    echo "  [SKIP] System monitoring requires Linux host counters"
    return 0
  fi

  local monitor_log monitor_pid
  monitor_log="$(resolve_path "$SYSTEM_MONITOR_LOG_PATH")"
  if ! mkdir -p "$(dirname "$monitor_log")" "$(dirname "$MONITOR_PID_FILE")"; then
    echo "  [WARN] Cannot create system-monitor log/PID directory; app services remain available."
    return 0
  fi
  # Bound previous-run logs. In-process collection errors are infrequent and
  # throttled; long-running native deployments should also configure logrotate.
  if [ -f "$monitor_log" ] && [ "$(wc -c < "$monitor_log")" -gt 5242880 ]; then
    if ! mv -f "$monitor_log" "$monitor_log.1"; then
      echo "  [WARN] Cannot rotate system-monitor log; app services remain available."
      return 0
    fi
  fi
  echo "  Starting system monitor (log: $monitor_log)..."
  (
    cd "$PROJECT_ROOT/server"
    export MONGO_URI="${MONGO_URI:-mongodb://localhost:$MONGO_PORT/qlicker}"
    export REDIS_URL
    if command -v nice &>/dev/null; then
      exec nohup nice -n 10 node --max-old-space-size=64 src/systemMonitor.js
    else
      exec nohup node --max-old-space-size=64 src/systemMonitor.js
    fi
  ) >> "$monitor_log" 2>&1 < /dev/null &
  monitor_pid=$!
  PIDS+=("system-monitor:$monitor_pid")
  if ! printf '%s\n' "$monitor_pid" > "$MONITOR_PID_FILE"; then
    kill_pid_gracefully "$monitor_pid"
    echo "  [WARN] Cannot record system-monitor PID; collector stopped. App services remain available."
    return 0
  fi
  sleep 0.25
  if is_qlicker_monitor_pid "$monitor_pid"; then
    echo "  [OK] System monitor started (PID: $monitor_pid)"
  else
    echo "  [WARN] System monitor exited; check $monitor_log. App services remain available."
  fi
}

start() {
  if [ -f "$PID_FILE" ]; then
    if has_running_pids_from_file; then
      echo "Qlicker appears to be already running. Run './scripts/qlicker.sh stop' first."
      exit 1
    fi
    echo "Found stale PID file at $PID_FILE. Continuing startup."
  fi
  if [ -f "$MONITOR_PID_FILE" ]; then
    local existing_monitor_pid
    read -r existing_monitor_pid < "$MONITOR_PID_FILE" || true
    if is_qlicker_monitor_pid "$existing_monitor_pid"; then
      echo "A Qlicker system monitor is already running. Run './scripts/qlicker.sh stop' first."
      exit 1
    fi
  fi

  echo "Starting Qlicker..."
  PIDS=()

  ensure_port_free "$API_PORT" "Server" || exit 1
  ensure_port_free "$APP_PORT" "Client" || exit 1

  ensure_workspace_dependencies "$PROJECT_ROOT/server" "Server"
  ensure_workspace_dependencies "$PROJECT_ROOT/client" "Client"

  # Start MongoDB if mongod is available and not already running
  if is_port_listening "$MONGO_PORT"; then
    echo "  [OK] MongoDB already listening on port $MONGO_PORT"
  else
    if command -v mongod &>/dev/null; then
      MONGO_DATA="$(resolve_path "$MONGO_DBPATH")"
      MONGO_LOG="$(resolve_path "$MONGO_LOG_PATH")"
      mkdir -p "$MONGO_DATA"
      mkdir -p "$(dirname "$MONGO_LOG")"
      echo "  Starting MongoDB on port $MONGO_PORT (dbpath: $MONGO_DATA)..."
      mongod --port "$MONGO_PORT" --dbpath "$MONGO_DATA" --fork --logpath "$MONGO_LOG" 2>/dev/null || \
        mongod --port "$MONGO_PORT" --dbpath "$MONGO_DATA" --fork --logpath "$MONGO_LOG"

      MONGO_PID=$(pgrep -f "mongod.*--port[[:space:]]*$MONGO_PORT" | tail -1 || true)
      if [ -n "$MONGO_PID" ]; then
        PIDS+=("mongo:$MONGO_PID")
        echo "  [OK] MongoDB started (PID: $MONGO_PID)"
      else
        echo "  [OK] MongoDB started"
      fi
    else
      echo "  [SKIP] mongod not found — expecting MongoDB on localhost:$MONGO_PORT"
    fi
  fi

  # Start Redis if REDIS_URL is set and redis-server is available
  if [ -n "$REDIS_URL" ]; then
    if is_port_listening "$REDIS_PORT"; then
      echo "  [OK] Redis already listening on port $REDIS_PORT"
    else
      if command -v redis-server &>/dev/null; then
        REDIS_PID_FILE="$(resolve_path "$REDIS_PID_PATH")"
        REDIS_LOG_FILE="$(resolve_path "$REDIS_LOG_PATH")"
        mkdir -p "$(dirname "$REDIS_PID_FILE")"
        mkdir -p "$(dirname "$REDIS_LOG_FILE")"
        echo "  Starting Redis on port $REDIS_PORT..."
        redis-server --port "$REDIS_PORT" --daemonize yes --loglevel warning --pidfile "$REDIS_PID_FILE" --logfile "$REDIS_LOG_FILE"
        REDIS_PID="$(tr -dc '0-9' < "$REDIS_PID_FILE" 2>/dev/null || true)"
        if [ -z "$REDIS_PID" ]; then
          REDIS_PID=$(pgrep -f "redis-server.*:$REDIS_PORT" | tail -1 || true)
        fi
        if [ -n "$REDIS_PID" ]; then
          PIDS+=("redis:$REDIS_PID")
          echo "  [OK] Redis started (PID: $REDIS_PID)"
        else
          echo "  [OK] Redis started"
        fi
      else
        echo "  [WARN] redis-server not found — expecting Redis on localhost:$REDIS_PORT"
        echo "         Install Redis or run: docker run -d -p $REDIS_PORT:6379 redis:7-alpine"
      fi
    fi
  else
    echo "  [SKIP] REDIS_URL not set — running in single-instance mode (no pub/sub)"
  fi

  # Start server
  echo "  Starting server on port $API_PORT..."
  (cd "$PROJECT_ROOT/server" && exec node src/server.js) &
  SERVER_PID=$!
  PIDS+=("server:$SERVER_PID")
  echo "  [OK] Server started (PID: $SERVER_PID)"
  if ! wait_for_port "$API_PORT"; then
    echo "  [ERROR] Server failed to bind to port $API_PORT."
    cleanup_started_pids "${PIDS[@]}"
    rm -f "$PID_FILE"
    exit 1
  fi

  # Start client dev server
  echo "  Starting client on port $APP_PORT..."
  VITE_BIN="$(find_vite_binary || true)"
  if [ -n "$VITE_BIN" ]; then
    (cd "$PROJECT_ROOT/client" && exec "$VITE_BIN" --port "$APP_PORT" --strictPort) &
  else
    echo "  [WARN] Local Vite binary not found; falling back to npm run dev."
    (cd "$PROJECT_ROOT/client" && exec npm run dev -- --port "$APP_PORT" --strictPort) &
  fi
  CLIENT_PID=$!
  PIDS+=("client:$CLIENT_PID")
  echo "  [OK] Client started (PID: $CLIENT_PID)"
  if ! wait_for_port "$APP_PORT"; then
    echo "  [ERROR] Client failed to bind to port $APP_PORT."
    cleanup_started_pids "${PIDS[@]}"
    rm -f "$PID_FILE"
    exit 1
  fi

  # Start monitoring after the app is ready. Failure must not block teaching.
  start_system_monitor

  # Write PID file
  printf "%s\n" "${PIDS[@]}" > "$PID_FILE"

  echo ""
  echo "Qlicker is running!"
  echo "  Client: http://localhost:$APP_PORT"
  echo "  API:    http://localhost:$API_PORT"
  echo ""
  echo "  PID file: $PID_FILE"
  echo "  Stop with: ./scripts/qlicker.sh stop"
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    if stop_orphaned_services; then
      echo "Qlicker stopped."
      return 0
    fi
    echo "No PID file found. Qlicker may not be running."
    return 0
  fi

  echo "Stopping Qlicker..."
  local entries=() line i NAME PID
  while IFS= read -r line; do entries+=("$line"); done < "$PID_FILE"
  # Also stop a collector omitted from an older/partial main PID file before
  # shutting down any database it needs for its final event.
  for line in "${entries[@]}"; do
    if [ "${line%%:*}" = "system-monitor" ]; then
      stop_qlicker_monitor "${line#*:}" || echo "  [SKIP] system-monitor (PID: ${line#*:}) not running or no longer owned by Qlicker"
    fi
  done
  stop_qlicker_monitor || true
  for ((i = ${#entries[@]} - 1; i >= 0; i--)); do
    line="${entries[$i]}"
    NAME="${line%%:*}"
    PID="${line#*:}"
    if [ "$NAME" = "system-monitor" ]; then
      continue
    elif is_running_pid "$PID"; then
      kill_pid_gracefully "$PID"
      echo "  [OK] Stopped $NAME (PID: $PID)"
    else
      echo "  [SKIP] $NAME (PID: $PID) not running"
    fi
  done

  stop_orphaned_services || true

  rm -f "$PID_FILE"
  echo "Qlicker stopped."
}

restart() {
  stop
  sleep 1
  start
}

run_e2e() {
  ensure_workspace_dependencies "$PROJECT_ROOT/server" "Server"
  ensure_workspace_dependencies "$PROJECT_ROOT/client" "Client"

  if [ "${2:-}" = "--install-browser" ]; then
    echo "Installing Playwright Chromium browser..."
    (cd "$PROJECT_ROOT/client" && npx playwright install chromium)
  fi

  echo "Running Playwright E2E tests..."
  (cd "$PROJECT_ROOT/client" && npm run test:e2e)
}

status() {
  if [ ! -f "$PID_FILE" ]; then
    local monitor_pid
    if [ -f "$MONITOR_PID_FILE" ]; then
      read -r monitor_pid < "$MONITOR_PID_FILE" || true
      if is_qlicker_monitor_pid "$monitor_pid"; then
        echo "  [RUNNING] Orphan system-monitor (PID: $monitor_pid); use './scripts/qlicker.sh stop'."
        return 0
      fi
    fi
    echo "Qlicker is not running (no PID file found)."
    exit 0
  fi

  echo "Qlicker status:"
  ALL_RUNNING=true
  while IFS= read -r line; do
    NAME=$(echo "$line" | cut -d: -f1)
    PID=$(echo "$line" | cut -d: -f2)
    if { [ "$NAME" = "system-monitor" ] && is_qlicker_monitor_pid "$PID"; } ||
      { [ "$NAME" != "system-monitor" ] && is_running_pid "$PID"; }; then
      echo "  [RUNNING] $NAME (PID: $PID)"
    else
      echo "  [STOPPED] $NAME (PID: $PID)"
      ALL_RUNNING=false
    fi
  done < "$PID_FILE"

  if ! grep -q '^system-monitor:' "$PID_FILE"; then
    local monitor_pid=''
    if [ -f "$MONITOR_PID_FILE" ]; then read -r monitor_pid < "$MONITOR_PID_FILE" || true; fi
    if is_qlicker_monitor_pid "$monitor_pid"; then
      echo "  [RUNNING] system-monitor (PID: $monitor_pid; recovered from its separate PID file)"
    elif [ "$SYSTEM_MONITOR_ENABLED" = "false" ]; then
      echo "  [DISABLED] system-monitor (SYSTEM_MONITOR_ENABLED=false)"
    elif [ "$(uname -s)" = "Linux" ]; then
      echo "  [STOPPED] system-monitor is not tracked; restart Qlicker to start it."
      ALL_RUNNING=false
    fi
  fi

  if $ALL_RUNNING; then
    echo ""
    echo "All services are running."
  else
    echo ""
    echo "Some services have stopped."
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) restart ;;
  status)  status ;;
  e2e)     run_e2e "$@" ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|e2e [--install-browser]}"
    exit 1
    ;;
esac
