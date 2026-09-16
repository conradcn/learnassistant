#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "[learn-assistant] Installing dependencies..."
  npm install
fi
export PORT="${PORT:-31544}"
echo "[learn-assistant] Open http://localhost:${PORT}"
exec npm run start -- "$@"
