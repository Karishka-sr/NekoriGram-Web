#!/bin/bash
# Останавливает узлы NekoriGram Web, запущенные через start-all.sh.
set -u
cd "$(dirname "$0")" || exit 1

for pid in $(pgrep -f "node server.js"); do
  if tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null | grep -q "^DATA_DIR=.*$(pwd)"; then
    kill "$pid" && echo "stopped pid $pid"
  fi
done
