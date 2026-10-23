#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSO_DIR="$(dirname "$SCRIPT_DIR")"
CERT_DIR="$SSO_DIR/certs"
FORCE=0

if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

mkdir -p "$CERT_DIR"

generate_cert() {
  local key_file="$1"
  local cert_file="$2"
  local subject="$3"

  if [[ $FORCE -eq 0 && -f "$key_file" && -f "$cert_file" ]]; then
    chmod 644 "$key_file" "$cert_file"
    echo "[skip] $(basename "$cert_file") already exists"
    return
  fi

  openssl req -x509 -nodes -newkey rsa:3072 \
    -keyout "$key_file" \
    -out "$cert_file" \
    -days 3650 \
    -subj "$subject" >/dev/null 2>&1

  chmod 644 "$key_file" "$cert_file"
  echo "[ok] generated $(basename "$cert_file")"
}

generate_cert "$CERT_DIR/idp.key" "$CERT_DIR/idp.crt" "/CN=Qlicker Local SimpleSAMLphp IdP"
generate_cert "$CERT_DIR/qlicker-sp.key" "$CERT_DIR/qlicker-sp.crt" "/CN=Qlicker Local SAML SP"
