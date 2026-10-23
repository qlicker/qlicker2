#!/bin/sh
# =============================================================================
# Qlicker nginx — TLS certificate selection & automatic renewal pickup
# =============================================================================
# Mounted at /docker-entrypoint.d/40-tls-certs.sh, so it runs inside the nginx
# container on every start, before nginx itself launches.
#
# It links the best available certificate pair into /etc/nginx/ssl (the paths
# nginx.conf points at), then keeps a background watcher running that re-runs
# the selection periodically and gracefully reloads nginx whenever the active
# certificate changes — e.g. after the certbot container renews it in the
# shared /etc/letsencrypt volume. No manual copy steps or restarts needed.
#
# Selection order:
#   1. Let's Encrypt live certs for $DOMAIN     (when CERTBOT_AUTORENEW=true)
#   2. Operator-provided certs                  (TLS_CERT_PATH/TLS_KEY_PATH mounts)
#   3. A generated self-signed placeholder      (so nginx can always boot,
#                                                e.g. before the first ACME issuance)
# =============================================================================

set -u

SSL_DIR=/etc/nginx/ssl
LE_DIR="/etc/letsencrypt/live/${DOMAIN:-localhost}"
PROVIDED_DIR=/etc/nginx/provided-certs
SELF_SIGNED_DIR=/etc/nginx/self-signed
CHECK_INTERVAL="${TLS_RELOAD_CHECK_SECONDS:-60}"

log() { echo "[tls-certs] $*" >&2; }

have_pair() {
  [ -s "$1/fullchain.pem" ] && [ -s "$1/privkey.pem" ]
}

ensure_self_signed() {
  have_pair "$SELF_SIGNED_DIR" && return 0
  # The nginx alpine image ships without the openssl CLI; this fallback is
  # only reached when neither Let's Encrypt nor provided certs exist.
  if ! command -v openssl >/dev/null 2>&1; then
    log "Installing openssl to generate a placeholder certificate ..."
    apk add --no-cache openssl >/dev/null 2>&1 || true
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    log "ERROR: no usable certificates found and openssl is unavailable to generate a placeholder."
    return 1
  fi
  mkdir -p "$SELF_SIGNED_DIR"
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$SELF_SIGNED_DIR/privkey.pem" \
    -out "$SELF_SIGNED_DIR/fullchain.pem" \
    -subj "/CN=${DOMAIN:-localhost}" >/dev/null 2>&1
  log "Generated self-signed placeholder certificate for ${DOMAIN:-localhost}."
}

# Links the preferred certificate pair into $SSL_DIR.
link_certs() {
  if [ "${CERTBOT_AUTORENEW:-false}" = "true" ] && have_pair "$LE_DIR"; then
    src="$LE_DIR"
  elif have_pair "$PROVIDED_DIR"; then
    src="$PROVIDED_DIR"
  else
    ensure_self_signed || return 1
    src="$SELF_SIGNED_DIR"
  fi
  mkdir -p "$SSL_DIR"
  ln -sf "$src/fullchain.pem" "$SSL_DIR/fullchain.pem"
  ln -sf "$src/privkey.pem" "$SSL_DIR/privkey.pem"
}

# Content hash of the active certificate (follows the symlink chain).
cert_fingerprint() {
  md5sum < "$SSL_DIR/fullchain.pem" 2>/dev/null || echo "none"
}

watch_renewals() {
  last="$(cert_fingerprint)"
  while :; do
    sleep "$CHECK_INTERVAL"
    link_certs || continue
    now="$(cert_fingerprint)"
    if [ "$now" != "$last" ]; then
      log "Certificate change detected (now serving from $src); reloading nginx."
      if nginx -s reload; then
        last="$now"
      else
        log "WARN: nginx reload failed; will retry in ${CHECK_INTERVAL}s."
      fi
    fi
  done
}

if ! link_certs; then
  log "ERROR: could not provision any TLS certificate; nginx will fail to start."
  exit 1
fi
log "Serving TLS certificates from $src (renewal check every ${CHECK_INTERVAL}s)."

watch_renewals &
