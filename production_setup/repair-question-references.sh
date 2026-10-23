#!/usr/bin/env bash
# Diagnose/repair question references using Node and dependencies inside Docker.
set -euo pipefail

REPAIR_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPAIR_COMPOSE=(docker compose --project-directory "$REPAIR_SCRIPT_DIR" -f "$REPAIR_SCRIPT_DIR/docker-compose.yml")
REPAIR_MODE=false
REPAIR_ARGS=()

usage() {
  cat <<'HELP'
Usage: ./repair-question-references.sh [--repair] [--course ID] [--session ID] [--json]

Default: read-only diagnostic of ALL sessions, listed by course and session name.
No host Node.js installation is needed; this uses the configured server image.

--repair      Review each affected session and choose a repair/grading action.
              Requires a terminal, a current backup, and stopped app servers.
--course ID   Optional: restrict to one course.
--session ID  Optional: restrict to one session.
--json        Machine-readable diagnostic (cannot be combined with --repair).

Examples:
  ./repair-question-references.sh
  ./backup.sh --label manual
  docker compose stop nginx server client
  ./repair-question-references.sh --repair
  ./repair-question-references.sh
  docker compose up -d server client nginx

Use the updated server image containing the repair utility. Leave MongoDB running.
HELP
}

while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --repair) REPAIR_MODE=true; shift ;;
    --json) REPAIR_ARGS+=("--json"); shift ;;
    --course|--session)
      if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then
        echo "Missing ID for $1" >&2; exit 1
      fi
      REPAIR_ARGS+=("$1" "$2"); shift 2 ;;
    *) echo "Unknown option: $1. Use --help." >&2; exit 1 ;;
  esac
done

command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }
"${REPAIR_COMPOSE[@]}" version >/dev/null
if "$REPAIR_MODE"; then
  for arg in "${REPAIR_ARGS[@]}"; do
    [[ "$arg" != --json ]] || { echo '--repair cannot be combined with --json.' >&2; exit 1; }
  done
  [[ -t 0 && -t 1 ]] || { echo '--repair requires an interactive terminal.' >&2; exit 1; }
  REPAIR_SERVER_IDS="$("${REPAIR_COMPOSE[@]}" ps --all --quiet server)"
  while IFS= read -r REPAIR_SERVER_ID; do
    [[ -n "$REPAIR_SERVER_ID" ]] || continue
    REPAIR_SERVER_STATE="$(docker inspect --format '{{.State.Status}}' "$REPAIR_SERVER_ID")"
    case "$REPAIR_SERVER_STATE" in
      exited|dead) ;;
      *)
        echo 'Before repairing, create a backup and stop ALL app server replicas (including paused/restarting containers):' >&2
        echo '  ./backup.sh --label manual' >&2
        echo '  docker compose stop nginx server client' >&2
        exit 1 ;;
    esac
  done <<< "$REPAIR_SERVER_IDS"
  read -r -p 'Confirm a current backup exists and all application writers are stopped. Type READY: ' REPAIR_READY
  [[ "$REPAIR_READY" == READY ]] || { echo 'Cancelled; no data changed.'; exit 0; }
  REPAIR_ARGS+=(--interactive)
  REPAIR_TTY=()
else
  REPAIR_TTY=(-T)
fi

# Compose reads production_setup/.env and passes MONGO_URI to the one-off server
# container. Never source/echo credentials and never start the application here.
exec "${REPAIR_COMPOSE[@]}" run --rm --no-deps "${REPAIR_TTY[@]}" server sh -c '
  test -f scripts/repair-question-references.js || {
    echo "The server image lacks the repair utility. Update SERVER_IMAGE to a release containing it." >&2
    exit 1
  }
  exec node scripts/repair-question-references.js "$@"
' repair-question-references "${REPAIR_ARGS[@]}"
