#!/usr/bin/env bash

# Start an isolated real PostgreSQL for #308 verification. Docker remains the
# preferred PG14 path; local runners fall back to installed Postgres on a
# random port. Call vnext_script_postgres_cleanup on exit.

vnext_script_postgres_start() {
  local database_name="$1"
  local name_prefix="$2"
  VNEXT_SCRIPT_PG_MODE=""
  VNEXT_SCRIPT_PG_CONTAINER=""
  VNEXT_SCRIPT_PG_DATA=""
  VNEXT_SCRIPT_PG_SOCKET=""
  VNEXT_SCRIPT_PG_CTL=""

  if docker info >/dev/null 2>&1; then
    VNEXT_SCRIPT_PG_MODE="docker"
    VNEXT_SCRIPT_PG_CONTAINER="${name_prefix}-$$"
    local password="${name_prefix}-local-$$"
    docker run -d --rm --name "$VNEXT_SCRIPT_PG_CONTAINER" \
      -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB="$database_name" \
      --tmpfs /var/lib/postgresql/data:rw,size=512m -p 127.0.0.1::5432 \
      "${POSTGRES_IMAGE:-postgres:14-alpine}" >/dev/null
    for _ in $(seq 1 30); do
      if docker exec -e PGPASSWORD="$password" "$VNEXT_SCRIPT_PG_CONTAINER" \
        psql -U postgres -d "$database_name" -c "SELECT 1" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    docker exec -e PGPASSWORD="$password" "$VNEXT_SCRIPT_PG_CONTAINER" \
      psql -U postgres -d "$database_name" -v ON_ERROR_STOP=1 \
      -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null
    local port
    port="$(docker port "$VNEXT_SCRIPT_PG_CONTAINER" 5432/tcp | cut -d: -f2)"
    VNEXT_SCRIPT_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database_name}"
    export VNEXT_SCRIPT_DATABASE_URL
    return
  fi

  local postgres_bin
  postgres_bin="$(command -v postgres || true)"
  if [[ -z "$postgres_bin" && -x /opt/homebrew/opt/postgresql@17/bin/postgres ]]; then
    postgres_bin="/opt/homebrew/opt/postgresql@17/bin/postgres"
  fi
  local postgres_directory
  postgres_directory="$(dirname "$postgres_bin")"
  if [[ -z "$postgres_bin" ]] \
    || [[ ! -x "${postgres_directory}/initdb" ]] \
    || [[ ! -x "${postgres_directory}/pg_ctl" ]] \
    || [[ ! -x "${postgres_directory}/psql" ]]; then
    echo "FAIL: Docker 不可用，且本机没有可用 PostgreSQL server" >&2
    return 1
  fi

  VNEXT_SCRIPT_PG_MODE="local"
  VNEXT_SCRIPT_PG_CTL="${postgres_directory}/pg_ctl"
  VNEXT_SCRIPT_PG_DATA="$(mktemp -d "${TMPDIR:-/tmp}/${name_prefix}-data.XXXXXX")"
  VNEXT_SCRIPT_PG_SOCKET="$(mktemp -d "${TMPDIR:-/tmp}/${name_prefix}-socket.XXXXXX")"
  local port
  port="$((20000 + (RANDOM % 30000)))"
  "${postgres_directory}/initdb" -D "$VNEXT_SCRIPT_PG_DATA" -A trust -U postgres \
    -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap >/dev/null
  "$VNEXT_SCRIPT_PG_CTL" -D "$VNEXT_SCRIPT_PG_DATA" -l "$VNEXT_SCRIPT_PG_DATA/server.log" \
    -o "-p ${port} -c listen_addresses='' -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap -k ${VNEXT_SCRIPT_PG_SOCKET}" \
    -w start >/dev/null
  PGHOST="$VNEXT_SCRIPT_PG_SOCKET" PGPORT="$port" "${postgres_directory}/psql" \
    -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE ${database_name}" >/dev/null
  PGHOST="$VNEXT_SCRIPT_PG_SOCKET" PGPORT="$port" "${postgres_directory}/psql" \
    -U postgres -d "$database_name" -v ON_ERROR_STOP=1 \
    -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null
  local encoded_socket
  encoded_socket="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$VNEXT_SCRIPT_PG_SOCKET")"
  VNEXT_SCRIPT_DATABASE_URL="postgresql://postgres@localhost:${port}/${database_name}?host=${encoded_socket}"
  export VNEXT_SCRIPT_DATABASE_URL
}

vnext_script_postgres_cleanup() {
  if [[ "${VNEXT_SCRIPT_PG_MODE:-}" == "docker" && -n "${VNEXT_SCRIPT_PG_CONTAINER:-}" ]]; then
    docker rm -f "$VNEXT_SCRIPT_PG_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ "${VNEXT_SCRIPT_PG_MODE:-}" == "local" && -n "${VNEXT_SCRIPT_PG_DATA:-}" ]]; then
    "${VNEXT_SCRIPT_PG_CTL:-pg_ctl}" -D "$VNEXT_SCRIPT_PG_DATA" -m fast -w stop >/dev/null 2>&1 || true
    rm -rf "$VNEXT_SCRIPT_PG_DATA"
  fi
  if [[ -n "${VNEXT_SCRIPT_PG_SOCKET:-}" ]]; then
    rm -rf "$VNEXT_SCRIPT_PG_SOCKET"
  fi
}
