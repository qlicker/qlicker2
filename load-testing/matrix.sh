#!/usr/bin/env bash
# Internal matrix driver; use ./run.sh --matrix [--students N].
set -euo pipefail
exec </dev/null
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
[[ $# == 2 && "$1" == --students && "$2" =~ ^[1-9][0-9]*$ ]] || exit 2
students="$2"
mkdir -p results state
# Prevent concurrent matrices from reseeding each other's active sessions.
exec 9>state/matrix.lock
flock -n 9 || { echo '[ERROR] Another matrix is already running.' >&2; exit 1; }
stamp="$(date +%Y%m%d-%H%M%S-%N)"
log="results/matrix-${stamp}.log"
summary="results/matrix-${stamp}.tsv"
resources="results/matrix-${stamp}-resources.jsonl"
# Save all preparation/cleanup output, including failures before k6 starts.
exec > >(trap '' INT TERM; tee "$log") 2>&1
printf 'scenario\tenrolled_percent\tlive_stats\texit_code\n' > "$summary"
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

monitor_pid=''
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$monitor_pid" ]]; then
    kill "$monitor_pid" 2>/dev/null
    wait "$monitor_pid" 2>/dev/null || echo "[WARN] Resource monitoring stopped unexpectedly; inspect $resources and its errors log."
    if [[ -s "results/matrix-${stamp}-resources-errors.log" ]]; then
      echo "[WARN] Resource monitoring reported errors; inspect results/matrix-${stamp}-resources-errors.log"
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
monitor_resources > "$resources" 2> "results/matrix-${stamp}-resources-errors.log" &
monitor_pid=$!
failed=0
for stats in off on; do
  for entry in live-named:100 live-external-named:100 live-external-named:50 live-external-named:0 live-external-anonymous:0 live-anonymous:100; do
    scenario="${entry%:*}"
    percent="${entry##*:}"
    echo "[INFO] $(date -u +%FT%TZ) Starting scenario=$scenario enrolled=$percent stats=$stats"
    status=0
    bash ./run.sh --scenario "$scenario" --enrolled-percent "$percent" \
      --students "$students" --session-chat off --live-stats "$stats" || status=$?
    printf '%s\t%s\t%s\t%s\n' "$scenario" "$percent" "$stats" "$status" >> "$summary"
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
