#!/usr/bin/env bash
# Build the AI Words image and start the app in Docker.
#
#   ./run.sh              build (if needed) and start
#   ./run.sh --rebuild    force a clean rebuild, then start
#   ./run.sh --logs       start and follow container logs
#
# The editor is served at http://localhost:8765/
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=ai-words
CONTAINER=ai-words
PORT=8765

REBUILD=0
FOLLOW=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    --logs)    FOLLOW=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

# Build the runtime image.
if [ "$REBUILD" -eq 1 ]; then
  docker build --no-cache -t "$IMAGE" .
else
  docker build -t "$IMAGE" .
fi

# Replace any existing container so config/port changes take effect.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# Mount the host config.json (API keys / active model) into the container's
# /data, and keep a named volume for persisted state (skills, edits).
docker run -d \
  --name "$CONTAINER" \
  -p "$PORT:8765" \
  -v ai-words-data:/data \
  -v "$(pwd)/config.json:/data/config.json" \
  --restart unless-stopped \
  "$IMAGE"

echo "AI Words running at http://localhost:$PORT/"

if [ "$FOLLOW" -eq 1 ]; then
  docker logs -f "$CONTAINER"
fi
