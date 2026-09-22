#!/usr/bin/env bash
set -euo pipefail

DB_USER="${SHASANADESH_DB_USER:-shasanadesh}"
DB_PASSWORD="${SHASANADESH_DB_PASSWORD:-shasanadesh_dev}"
DB_NAME="${SHASANADESH_DB_NAME:-shasanadesh}"
DB_HOST="${SHASANADESH_DB_HOST:-localhost}"
DB_PORT="${SHASANADESH_DB_PORT:-5432}"

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is not installed."
  echo
  echo "On macOS with Homebrew, install PostgreSQL first, for example:"
  echo "  brew install postgresql@16"
  echo
  echo "Then start it:"
  echo "  brew services start postgresql@16"
  exit 1
fi

echo "Local PostgreSQL bootstrap"
echo "=========================="
echo "psql: $(psql --version)"
echo "target: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo

# Connect using the current local PostgreSQL identity. On a typical Homebrew
# installation the current macOS user has a PostgreSQL superuser role.
if ! psql -h "$DB_HOST" -p "$DB_PORT" -d postgres -Atqc "SELECT 1" >/dev/null 2>&1; then
  echo "ERROR: Cannot connect to local PostgreSQL database 'postgres'."
  echo
  echo "Useful diagnostics:"
  echo "  pg_isready -h ${DB_HOST} -p ${DB_PORT}"
  echo "  brew services list | grep -E 'postgres|postgresql'"
  echo "  lsof -nP -iTCP:${DB_PORT} -sTCP:LISTEN"
  echo
  echo "If PostgreSQL is not running, start the version you installed with Homebrew."
  exit 1
fi

echo "Connected to local PostgreSQL."

ROLE_EXISTS="$(
  psql -h "$DB_HOST" -p "$DB_PORT" -d postgres -Atqc \
    "SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}'" || true
)"

if [[ "$ROLE_EXISTS" != "1" ]]; then
  echo "Creating role '${DB_USER}'..."
  psql -h "$DB_HOST" -p "$DB_PORT" -d postgres \
    -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';"
else
  echo "Role '${DB_USER}' already exists."
fi

DB_EXISTS="$(
  psql -h "$DB_HOST" -p "$DB_PORT" -d postgres -Atqc \
    "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" || true
)"

if [[ "$DB_EXISTS" != "1" ]]; then
  echo "Creating database '${DB_NAME}' owned by '${DB_USER}'..."
  psql -h "$DB_HOST" -p "$DB_PORT" -d postgres \
    -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
else
  echo "Database '${DB_NAME}' already exists."
  psql -h "$DB_HOST" -p "$DB_PORT" -d postgres \
    -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};" >/dev/null
fi

echo
echo "Checking required extensions..."

if ! psql -h "$DB_HOST" -p "$DB_PORT" -d "$DB_NAME" -Atqc \
  "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'" \
  | grep -q '^1$'; then
  echo
  echo "ERROR: pgvector extension is not available to this PostgreSQL server."
  echo
  echo "On Homebrew, usually:"
  echo "  brew install pgvector"
  echo
  echo "Then restart PostgreSQL if necessary and rerun this script."
  echo
  echo "Server version:"
  psql -h "$DB_HOST" -p "$DB_PORT" -d postgres -Atqc "SHOW server_version;" || true
  exit 2
fi

psql -h "$DB_HOST" -p "$DB_PORT" -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" >/dev/null

CONNECTION_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

echo "Extensions ready: vector, pg_trgm"
echo
echo "Local database is ready."
echo
echo "For this terminal session:"
echo "  export DATABASE_URL='${CONNECTION_URL}'"
echo
echo "Then run:"
echo "  npm run db:migrate"
echo "  npm run db:load"
echo "  npm run db:audit"
