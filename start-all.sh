#!/bin/bash
# Запускает оба узла NekoriGram Web в фоне. Повторный запуск не создаёт дубли.
set -u
cd "$(dirname "$0")" || exit 1

LOG_DIR="${LOG_DIR:-$(pwd)/logs}"
mkdir -p "$LOG_DIR"

if [ ! -f .env ] || ! grep -q '^TOKEN_SECRET=.\+' .env 2>/dev/null; then
  umask 077
  printf 'TOKEN_SECRET=%s\n' "$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")" >> .env
  echo "создан .env с общим TOKEN_SECRET"
fi

start_node() {
  local port="$1" script="$2" log="$3"
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    exec 3<&- 3>&-
    echo "node on :${port} already running"
    return 0
  fi
  nohup "./${script}" >> "${LOG_DIR}/${log}" 2>&1 &
  echo "started ${script} (pid $!) -> ${LOG_DIR}/${log}"
}

start_node 12000 start-node1.sh node1.log
start_node 12001 start-node2.sh node2.log
