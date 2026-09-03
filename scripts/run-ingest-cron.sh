#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(dirname "$0")")"
set -a
. ./.env
set +a

exec npm run ingest
