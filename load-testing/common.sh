#!/usr/bin/env bash

env_val() {
  local file_path="$1"
  local key="$2"
  if [[ -f "$file_path" ]]; then
    grep -E "^${key}=" "$file_path" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//'
  fi
}

resolve_abs_path() {
  local input_path="$1"
  if [[ -z "$input_path" ]]; then
    return 1
  fi
  if [[ "$input_path" = /* ]]; then
    printf '%s\n' "$input_path"
    return 0
  fi
  (
    cd "$(dirname "$input_path")" 2>/dev/null && \
    printf '%s/%s\n' "$(pwd)" "$(basename "$input_path")"
  )
}

stack_compose_ps() {
  local stack_dir="$1"
  local env_path="$2"
  local compose_file="$3"
  local service="${4:-mongo}"

  docker compose \
    --project-directory "$stack_dir" \
    --env-file "$env_path" \
    -f "$compose_file" \
    ps -q "$service" 2>/dev/null | head -1
}

detect_docker_network() {
  local stack_dir="$1"
  local env_path="$2"
  local compose_file="$3"
  local service="${4:-mongo}"
  local container_id=""

  if [[ ! -f "$compose_file" ]]; then
    return 0
  fi

  container_id="$(stack_compose_ps "$stack_dir" "$env_path" "$compose_file" "$service" || true)"
  if [[ -n "$container_id" ]]; then
    docker inspect "$container_id" \
      --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null || true
  fi
}

resolve_base_url() {
  local target_env="$1"
  local env_path="$2"
  local root_url=""
  local domain=""
  local api_url=""
  local api_port=""
  local port=""

  root_url="$(env_val "$env_path" ROOT_URL)"
  domain="$(env_val "$env_path" DOMAIN)"
  api_url="$(env_val "$env_path" VITE_API_URL)"
  api_port="$(env_val "$env_path" API_PORT)"
  port="$(env_val "$env_path" PORT)"

  if [[ "$target_env" == "dev" ]]; then
    if [[ -n "$api_url" ]]; then
      printf '%s\n' "$api_url"
      return 0
    fi
    if [[ -n "$api_port" ]]; then
      printf 'http://localhost:%s\n' "$api_port"
      return 0
    fi
    if [[ -n "$port" ]]; then
      printf 'http://localhost:%s\n' "$port"
      return 0
    fi
    if [[ -n "$root_url" ]]; then
      printf '%s\n' "$root_url"
      return 0
    fi
    return 1
  fi

  if [[ -n "$root_url" ]]; then
    printf '%s\n' "$root_url"
    return 0
  fi
  if [[ -n "$domain" ]]; then
    printf 'https://%s\n' "$domain"
    return 0
  fi
  if [[ -n "$api_port" ]]; then
    printf 'http://localhost:%s\n' "$api_port"
    return 0
  fi
  return 1
}

resolve_mongo_url() {
  local env_path="$1"
  local mongo_uri=""
  local mongo_url=""
  local mongo_port=""

  mongo_uri="$(env_val "$env_path" MONGO_URI)"
  mongo_url="$(env_val "$env_path" MONGO_URL)"
  mongo_port="$(env_val "$env_path" MONGO_PORT)"

  if [[ -n "$mongo_uri" ]]; then
    printf '%s\n' "$mongo_uri"
    return 0
  fi
  if [[ -n "$mongo_url" ]]; then
    printf '%s\n' "$mongo_url"
    return 0
  fi
  if [[ -n "$mongo_port" ]]; then
    printf 'mongodb://localhost:%s/qlicker\n' "$mongo_port"
    return 0
  fi
  return 1
}

# Include every file copied into the seed image. A checkout update can change the
# seed program without changing the image tag used by an earlier setup run.
seed_image_fingerprint() {
  local script_dir="$1"
  (
    cd "$script_dir"
    git hash-object Dockerfile.seed package.json package-lock.json seed.mjs | git hash-object --stdin
  )
}
