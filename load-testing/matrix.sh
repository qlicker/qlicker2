#!/usr/bin/env bash
# Internal comparison driver; use ./run.sh --regression, --ordinary, or --matrix.
set -euo pipefail
exec </dev/null
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
[[ $# -ge 2 && "$1" == --students && "$2" =~ ^[1-9][0-9]*$ ]] || exit 2
students="$2"
shift 2
profile=matrix
stats_mode=both
while (( $# )); do
  case "$1" in
    --profile) [[ $# -ge 2 ]] || exit 2; profile="$2"; shift 2 ;;
    --stats) [[ $# -ge 2 ]] || exit 2; stats_mode="$2"; shift 2 ;;
    *) exit 2 ;;
  esac
done
[[ "$profile" == matrix || "$profile" == ordinary || "$profile" == regression ]] || exit 2
[[ "$stats_mode" == both || "$stats_mode" == on || "$stats_mode" == off ]] || exit 2
[[ "$profile" != matrix || "$stats_mode" == both ]] || exit 2
[[ "$profile" != regression || "$stats_mode" == off ]] || exit 2
entries=(live-named:100 live-external-named:100 live-external-named:50 live-external-named:0 live-external-anonymous:0 live-anonymous:100)
if [[ "$profile" != matrix ]]; then entries=(live-named:100); fi
chat_mode=off
if [[ "$profile" == regression ]]; then chat_mode=on; fi
stats_modes=(off on)
if [[ "$stats_mode" != both ]]; then stats_modes=("$stats_mode"); fi
mkdir -p results state
# Prevent concurrent matrices from reseeding each other's active sessions.
exec 9>state/matrix.lock
flock -n 9 || { echo '[ERROR] Another matrix is already running.' >&2; exit 1; }
stamp="$(date +%Y%m%d-%H%M%S-%N)"
log="results/${profile}-${stamp}.log"
summary="results/${profile}-${stamp}.tsv"
resources="results/${profile}-${stamp}-resources.jsonl"
# Save all preparation/cleanup output, including failures before k6 starts.
exec > >(trap '' INT TERM; tee "$log") 2>&1
printf 'scenario\tenrolled_percent\tlive_stats\texit_code\n' > "$summary"
echo "[INFO] Comparison profile: $profile; statistics modes: ${stats_modes[*]}; chat: $chat_mode; students: $students"
echo "[INFO] Matrix log: $SCRIPT_DIR/$log"
echo "[INFO] Matrix summary: $SCRIPT_DIR/$summary"
echo "[INFO] Resource samples: $SCRIPT_DIR/$resources"
revision="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ "$revision" != unknown ]] && ! git -C "$SCRIPT_DIR" diff --quiet HEAD -- .; then
  revision="${revision}-modified"
fi
echo "[INFO] Load-test checkout: $revision; host logical CPUs: $(getconf _NPROCESSORS_ONLN 2>/dev/null || echo unknown)"
echo "[INFO] Configured k6 image: ${K6_IMAGE:-grafana/k6:latest}"
echo "[INFO] Cached k6 image ID: $(docker image inspect --format '{{.Id}}' "${K6_IMAGE:-grafana/k6:latest}" 2>/dev/null || echo unavailable-before-run)"

# Inspect only explicitly selected fields; never dump container environments.
snapshot_stack() {
  local phase="$1" ids id
  printf '[INFO] %s Container snapshot: %s\n' "$(date -u +%FT%TZ)" "$phase"
  if [[ -z "${STACK_DIR:-}" || -z "${TARGET_ENV_FILE:-}" || -z "${TARGET_COMPOSE_FILE:-}" ]]; then
    echo '[WARN] Stack paths unavailable for container diagnostics.'
    return
  fi
  if ! ids="$(docker compose --project-directory "$STACK_DIR" --env-file "$TARGET_ENV_FILE" -f "$TARGET_COMPOSE_FILE" ps -aq)"; then
    echo '[WARN] Could not list stack containers.'
    return
  fi
  for id in $ids; do
    docker inspect --format '{"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"restartCount":{{.RestartCount}},"status":{{json .State.Status}},"oomKilled":{{.State.OOMKilled}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}}}' "$id" || echo '[WARN] Container inspection failed.'
  done
}

monitor_pid=''
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$monitor_pid" ]]; then
    kill "$monitor_pid" 2>/dev/null
    wait "$monitor_pid" 2>/dev/null || echo "[WARN] Resource monitoring stopped unexpectedly; inspect $resources and its errors log."
    if [[ -s "results/${profile}-${stamp}-resources-errors.log" ]]; then
      echo "[WARN] Resource monitoring reported errors; inspect results/${profile}-${stamp}-resources-errors.log"
    fi
  fi
  if [[ -f state/rate-limit-restore.env ]]; then
    bash ./run.sh --restore || status=1
  fi
  bash ./run.sh --clean || status=1
  echo '[INFO] Matrix results (0 = passed; other codes = failed):'
  cat "$summary"
  echo "[INFO] Matrix finished with exit code $status; log: $SCRIPT_DIR/$log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A previous interrupted prepare has a saved original configuration.
if [[ -f state/rate-limit-restore.env ]]; then
  bash ./run.sh --restore
fi
bash ./run.sh --prepare

monitor_resources() {
  local child=''
  trap '[[ -z "$child" ]] || kill "$child" 2>/dev/null; exit 0' TERM INT
  while true; do
    printf '{"sampledAt":"%s","hostLoad":"%s"}\n' "$(date -u +%FT%TZ)" "$(cat /proc/loadavg)"
    # Names and utilization only: no environment, credentials, or request data.
    docker stats --no-stream --format '{{json .}}' &
    child=$!
    wait "$child" || return
    sleep 5 &
    child=$!
    wait "$child" || return
  done
}
monitor_resources > "$resources" 2> "results/${profile}-${stamp}-resources-errors.log" &
monitor_pid=$!
failed=0
for stats in "${stats_modes[@]}"; do
  for entry in "${entries[@]}"; do
    scenario="${entry%:*}"
    percent="${entry##*:}"
    echo "[INFO] $(date -u +%FT%TZ) Starting scenario=$scenario enrolled=$percent stats=$stats"
    snapshot_stack "before $scenario stats=$stats"
    status=0
    bash ./run.sh --scenario "$scenario" --enrolled-percent "$percent" \
      --students "$students" --session-chat "$chat_mode" --live-stats "$stats" || status=$?
    printf '%s\t%s\t%s\t%s\n' "$scenario" "$percent" "$stats" "$status" >> "$summary"
    snapshot_stack "after $scenario stats=$stats"
    if (( status != 0 )); then
      failed=1
      # Threshold failures carry useful comparisons; infrastructure failures do not.
      if (( status != 99 )); then
        echo "[ERROR] Stopping matrix after infrastructure/interruption failure ($status)."
        exit "$status"
      fi
    fi
  done
done
exit "$failed"
