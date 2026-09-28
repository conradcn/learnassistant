#!/bin/sh
# The container's equivalent of start.sh: make the data root usable, say plainly what the
# selected provider can and cannot do from in here, print the URL, and hand over to the
# server. It never builds — the image already holds the production build, and a rebuild
# would need dev dependencies the runtime layer deliberately does not carry.
set -eu

PORT="${PORT:-31544}"
DATA_ROOT="${LA_DATA_ROOT:-/app/data}"
PROVIDER="${LA_PROVIDER:-claude}"

# A bind-mounted ./data arrives owned by whoever owns it on the host. If that is not this
# user, every write fails later and further in — say so here instead, and name the fix.
if ! mkdir -p "$DATA_ROOT/logs" "$DATA_ROOT/topics" "$DATA_ROOT/staging" 2>/dev/null \
   || ! touch "$DATA_ROOT/.writable" 2>/dev/null; then
  echo "[learn-assistant] Cannot write to $DATA_ROOT (running as uid $(id -u), gid $(id -g))." >&2
  echo "[learn-assistant] The ./data bind mount is owned by another user on the host." >&2
  echo "[learn-assistant] Set LA_UID and LA_GID in .env to your own ids (\`id -u\` / \`id -g\`) and run docker compose up again." >&2
  exit 1
fi
rm -f "$DATA_ROOT/.writable"

case "$PROVIDER" in
  claude)
    if command -v claude >/dev/null 2>&1; then
      echo "[learn-assistant] Provider 'claude': the CLI is on PATH. If it is not signed in inside this container, lesson writing will fail — see README, 'The claude CLI in a container'."
    else
      echo "[learn-assistant] Provider 'claude' is selected but the claude CLI is NOT in this container, so no lessons can be written." >&2
      echo "[learn-assistant] Set LA_PROVIDER in .env to an API provider (anthropic, openai, gemini, mistral) or to 'ollama', or change it in Settings." >&2
      echo "[learn-assistant] See README, 'Setup and run' > 'With Docker'." >&2
    fi
    ;;
  ollama|llama|openai-compatible)
    echo "[learn-assistant] Provider '$PROVIDER' runs on your host, not in here — the container reaches it at host.docker.internal, not 127.0.0.1."
    echo "[learn-assistant] The server must also be listening on more than loopback (for Ollama: OLLAMA_HOST=0.0.0.0)."
    ;;
esac

echo "[learn-assistant] Open http://localhost:${PORT}"
# WHY LA_BIND_HOST and not $HOSTNAME: docker sets HOSTNAME to the container id, so reading
# it here would bind the server to one interface by name instead of to all of them.
exec node_modules/.bin/next start -p "$PORT" -H "${LA_BIND_HOST:-0.0.0.0}"
