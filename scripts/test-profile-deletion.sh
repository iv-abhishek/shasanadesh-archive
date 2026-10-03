#!/usr/bin/env bash
# npm run test:profile-deletion — profile delete / restore / purge (ADR-079)
# against a throwaway database, never the real one:
#   1. creates shasanadesh_deletion_test (as your local PostgreSQL superuser,
#      like scripts/setup-local-postgres.sh), owned by the app role
#   2. applies every migration, runs the test, drops the database again
set -euo pipefail

DB_USER="${SHASANADESH_DB_USER:-shasanadesh}"
DB_PASSWORD="${SHASANADESH_DB_PASSWORD:-shasanadesh_dev}"
DB_HOST="${SHASANADESH_DB_HOST:-localhost}"
DB_PORT="${SHASANADESH_DB_PORT:-5432}"
TEST_DB="shasanadesh_deletion_test"

admin() { psql -h "$DB_HOST" -p "$DB_PORT" -v ON_ERROR_STOP=1 -Atq "$@"; }

if ! admin -d postgres -c "SELECT 1" >/dev/null 2>&1; then
  echo "Cannot connect to PostgreSQL at ${DB_HOST}:${DB_PORT} as $(whoami)."
  echo "Start it (brew services start postgresql@16) or set SHASANADESH_DB_HOST / SHASANADESH_DB_PORT."
  exit 1
fi

cleanup() { admin -d postgres -c "DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
admin -d postgres -c "CREATE DATABASE ${TEST_DB} OWNER ${DB_USER};" >/dev/null
admin -d "$TEST_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" >/dev/null

TEST_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${TEST_DB}"
echo "Scratch database ${TEST_DB}: applying migrations…"
# Node's --env-file does not override variables already set, so .env's
# DATABASE_URL (the real database) is not used here.
DATABASE_URL="$TEST_URL" node --env-file-if-exists=.env --import tsx src/db/migrate.ts >/dev/null
TEST_DATABASE_URL="$TEST_URL" DATABASE_URL="$TEST_URL" node --env-file-if-exists=.env --import tsx src/workspace/profile-deletion.test.ts
