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
#
# app/static is mounted over the copy baked into the image so an edit to the
# frontend (the pages, ai-pane.js, the stylesheets) shows up on a reload instead
# of needing the image rebuilt — the server reads those files per request. It is
# read-only because the app only ever serves them. Nothing else is mounted: the
# Python under app/ is imported once at startup, so live-mounting it would only
# give a half-reloaded process.
#
# MSYS_NO_PATHCONV is for Git Bash on Windows, which rewrites any argument that
# looks like a Unix path into a Windows one — mangling both halves of every -v
# (a source of `.../config.json;C`, a destination of `\Program Files\Git\data\
# config.json`), so the mounts silently landed nowhere. It is an ordinary unset
# variable on Linux and macOS, where the command is unaffected.
MSYS_NO_PATHCONV=1 docker run -d \
  --name "$CONTAINER" \
  -p "$PORT:8765" \
  -v ai-words-data:/data \
  -v "$(pwd)/config.json:/data/config.json" \
  -v "$(pwd)/app/static:/app/app/static:ro" \
  --restart unless-stopped \
  "$IMAGE"

echo "AI Words running at http://localhost:$PORT/"

if [ "$FOLLOW" -eq 1 ]; then
  docker logs -f "$CONTAINER"
fi
