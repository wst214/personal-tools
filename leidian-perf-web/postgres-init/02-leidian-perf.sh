#!/bin/bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
    SELECT 'CREATE DATABASE leidian_perf OWNER leidian'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'leidian_perf')\gexec
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "leidian_perf" <<-'EOSQL'
    CREATE EXTENSION IF NOT EXISTS postgis;
EOSQL
