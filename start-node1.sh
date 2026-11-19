#!/bin/bash
# NekoriGram Web — узел 1 (порт 12000)
cd "$(dirname "$0")" || exit 1
[ -f .env ] && set -a && . ./.env && set +a
export DATA_DIR="${DATA_DIR:-$(pwd)/data}"
export PORT=12000
export HOST=0.0.0.0
if [ -z "${TOKEN_SECRET:-}" ]; then
  echo "TOKEN_SECRET не задан. Запустите ./start-all.sh — он создаст .env" >&2
  exit 1
fi
exec node server.js