#!/usr/bin/env bash
# =============================================================================
# Qlicker — Build and Tag Docker Images
# =============================================================================
# Builds production Docker images for the server and client, and optionally
# pushes them to a container registry.
#
# Usage:
#   ./scripts/build-images.sh                        # Build with default tag
#   ./scripts/build-images.sh --tag v2.0.0           # Build with specific tag
#   ./scripts/build-images.sh --tag latest --push    # Build and push
#   ./scripts/build-images.sh --registry ghcr.io/org # Use specific registry
#
# Options:
#   --tag TAG          Image tag (default: VERSION file value, else latest)
#   --registry REG     Registry prefix (default: qlicker)
#   --app-version VER  Runtime app version baked into images (default: TAG)
#   --push             Push images after building
#   --no-cache         Build without Docker cache
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VERSION_FILE="$PROJECT_ROOT/VERSION"

# Defaults
DEFAULT_TAG="latest"
if [ -f "$VERSION_FILE" ]; then
  VERSION_FROM_FILE="$(head -n 1 "$VERSION_FILE" | tr -d '\r' | xargs)"
  if [ -n "$VERSION_FROM_FILE" ]; then
    DEFAULT_TAG="$VERSION_FROM_FILE"
  fi
fi
TAG="$DEFAULT_TAG"
REGISTRY="qlicker"
APP_VERSION=""
PUSH=false
NO_CACHE=""

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)      TAG="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --app-version) APP_VERSION="$2"; shift 2 ;;
    --push)     PUSH=true; shift ;;
    --no-cache) NO_CACHE="--no-cache"; shift ;;
    --help|-h)
      echo "Usage: ./scripts/build-images.sh [--tag TAG] [--registry REG] [--app-version VER] [--push] [--no-cache]"
      exit 0
      ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [ -z "$APP_VERSION" ]; then
  APP_VERSION="$TAG"
fi

GREEN='\033[0;32m'; NC='\033[0m'
info() { printf "${GREEN}[INFO]${NC} %s\n" "$*"; }

SERVER_IMAGE="$REGISTRY/qlicker-server:$TAG"
CLIENT_IMAGE="$REGISTRY/qlicker-client:$TAG"

echo "======================================"
echo "  Qlicker — Build Docker Images"
echo "======================================"
echo ""
echo "  Server: $SERVER_IMAGE"
echo "  Client: $CLIENT_IMAGE"
echo "  App version: $APP_VERSION"
echo ""

# ---- Build server image ------------------------------------------------------
info "Building server image..."
docker build $NO_CACHE \
  --build-arg "APP_VERSION=$APP_VERSION" \
  -t "$SERVER_IMAGE" \
  -f "$PROJECT_ROOT/server/Dockerfile" \
  "$PROJECT_ROOT/server"

info "Server image built: $SERVER_IMAGE"

# ---- Build client image ------------------------------------------------------
info "Building client image..."
docker build $NO_CACHE \
  --build-arg "APP_VERSION=$APP_VERSION" \
  -t "$CLIENT_IMAGE" \
  -f "$PROJECT_ROOT/client/Dockerfile" \
  "$PROJECT_ROOT/client"

info "Client image built: $CLIENT_IMAGE"

# ---- Also tag as latest if tag is not already "latest" -----------------------
if [ "$TAG" != "latest" ]; then
  docker tag "$SERVER_IMAGE" "$REGISTRY/qlicker-server:latest"
  docker tag "$CLIENT_IMAGE" "$REGISTRY/qlicker-client:latest"
  info "Also tagged as :latest"
fi

# ---- Push if requested -------------------------------------------------------
if [ "$PUSH" = true ]; then
  info "Pushing images..."
  docker push "$SERVER_IMAGE"
  docker push "$CLIENT_IMAGE"
  if [ "$TAG" != "latest" ]; then
    docker push "$REGISTRY/qlicker-server:latest"
    docker push "$REGISTRY/qlicker-client:latest"
  fi
  info "Images pushed to $REGISTRY"
fi

echo ""
info "Done! Images:"
echo "  $SERVER_IMAGE"
echo "  $CLIENT_IMAGE"
echo ""
echo "  To use in production_setup/docker-compose.yml, update the server/client"
echo "  service definitions to use 'image:' instead of 'build:':"
echo "    image: $SERVER_IMAGE"
echo "    image: $CLIENT_IMAGE"
