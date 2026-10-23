#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SANITIZE_S3=false

while [ $# -gt 0 ]; do
  case "$1" in
    --sanitize-s3)
      SANITIZE_S3=true
      shift
      ;;
    --help|-h)
      echo "Usage: ./scripts/init-from-legacy.sh [--sanitize-s3]"
      echo "  Restores a legacy dump into the native dev database, then applies"
      echo "  the question-type migration."
      echo "  --sanitize-s3   Also rewrite legacy S3 URLs to /uploads/... and run the ACL pass"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_ROOT/.env"
  set +a
fi

echo "Restoring legacy dump into native dev database..."
"$SCRIPT_DIR/seed-db.sh" --legacy-restore

echo "Reconciling settings singleton..."
(
  cd "$PROJECT_ROOT/server"
  node scripts/reconcile-settings-singleton.js
)

echo "Applying question-type migration..."
(
  cd "$PROJECT_ROOT/server"
  node scripts/migrate-question-types.js --apply
)

if [ "$SANITIZE_S3" = true ]; then
  echo "Running S3 sanitization..."
  (
    cd "$PROJECT_ROOT"
    node production_setup/sanitize-s3.js --apply
  )
fi

echo "Legacy initialization complete."
