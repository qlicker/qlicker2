#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSO_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$SSO_DIR")"
ENV_FILE="$SSO_DIR/.env"
STATE_FILE="${QCLICKER_E2E_STATE_FILE:-/tmp/qlicker-sso-e2e-state.json}"
ADMIN_STATE_FILE="${QCLICKER_E2E_ADMIN_STATE_FILE:-/tmp/qlicker-sso-e2e-admin.json}"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SSO_DIR/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE from .env.example. Review it before re-running if you need custom ports or credentials."
fi

readarray -t CONFIG_VALUES < <(
  node --input-type=module - "$SSO_DIR/.env.example" "$ENV_FILE" <<'EOF'
import fs from 'fs';

const [, , examplePath, envPath] = process.argv;

function parseEnv(raw) {
  return raw.split(/\r?\n/).reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return acc;
    const separator = trimmed.indexOf('=');
    if (separator === -1) return acc;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    acc[key] = value;
    return acc;
  }, {});
}

const merged = [examplePath, envPath].reduce((acc, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return acc;
  return { ...acc, ...parseEnv(fs.readFileSync(filePath, 'utf8')) };
}, {});

const ssoserverPort = merged.SSOSERVER_PORT || '4100';
const ssoserverBaseUrl = merged.SSOSERVER_BASE_URL || `http://127.0.0.1:${ssoserverPort}`;
const qlickerAppUrl = merged.QCLICKER_APP_URL || 'http://127.0.0.1:3300';
const qlickerApiUrl = merged.QCLICKER_API_URL || 'http://127.0.0.1:3301/api/v1';
const qlickerSpEntityId = merged.QCLICKER_SP_ENTITY_ID || `${qlickerAppUrl}/SSO/SAML2/metadata`;

console.log(ssoserverBaseUrl);
console.log(qlickerAppUrl);
console.log(qlickerApiUrl);
console.log(qlickerSpEntityId);
EOF
)

SSOSERVER_BASE_URL="${CONFIG_VALUES[0]}"
QCLICKER_APP_URL="${CONFIG_VALUES[1]}"
QCLICKER_API_URL="${CONFIG_VALUES[2]}"
QCLICKER_SP_ENTITY_ID="${CONFIG_VALUES[3]}"

"$SCRIPT_DIR/generate-certs.sh"
(
  cd "$SSO_DIR"
  SSOSERVER_BASE_URL="$SSOSERVER_BASE_URL" \
  QCLICKER_APP_URL="$QCLICKER_APP_URL" \
  QCLICKER_API_URL="$QCLICKER_API_URL" \
  QCLICKER_SP_ENTITY_ID="$QCLICKER_SP_ENTITY_ID" \
  node "$SCRIPT_DIR/render-config.mjs"
)

cleanup() {
  (cd "$SSO_DIR" && docker compose down >/dev/null 2>&1 || true)
}
trap cleanup EXIT

(cd "$SSO_DIR" && docker compose up -d --build)

echo "Waiting for SimpleSAMLphp IdP to become healthy..."
for _ in {1..30}; do
  if curl -fsS "${SSOSERVER_BASE_URL}/simplesaml/" >/dev/null 2>&1; then
    break
  fi
  sleep 2
 done

curl -fsS "${SSOSERVER_BASE_URL}/simplesaml/" >/dev/null

echo "Ensuring Playwright Chromium is installed..."
(
  cd "$REPO_ROOT/client"
  npx playwright install chromium >/dev/null
)

echo "Running Playwright SSO smoke tests..."
(
  cd "$REPO_ROOT/client"
  APP_PORT="$(echo "$QCLICKER_APP_URL" | sed -E 's#^https?://[^:]+:([0-9]+).*$#\1#')" \
  API_PORT="$(echo "$QCLICKER_API_URL" | sed -E 's#^https?://[^:]+:([0-9]+).*$#\1#')" \
  SSOSERVER_BASE_URL="$SSOSERVER_BASE_URL" \
  QCLICKER_APP_URL="$QCLICKER_APP_URL" \
  QCLICKER_API_URL="$QCLICKER_API_URL" \
  QCLICKER_SP_ENTITY_ID="$QCLICKER_SP_ENTITY_ID" \
  QCLICKER_E2E_STATE_FILE="$STATE_FILE" \
  QCLICKER_E2E_ADMIN_STATE_FILE="$ADMIN_STATE_FILE" \
  QCLICKER_SSO_IDP_BASE_URL="$SSOSERVER_BASE_URL" \
  npm run test:e2e -- --config playwright.sso.config.js
)
