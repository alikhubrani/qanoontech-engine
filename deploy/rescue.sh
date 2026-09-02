#!/usr/bin/env bash
#
# The way back in when the engine itself will not start.
#
# The engine renders everything it manages to one compose file and leaves it
# on its volume precisely so that this script can exist: nothing below knows
# anything about the engine except where that file lives. This is a recovery
# path, not a second way to install — it configures nothing, changes no
# versions, and touches no licence.
#
#   ./rescue.sh up        bring the firm's system up from the last rendered state
#   ./rescue.sh down      stop it (volumes and data are never touched)
#   ./rescue.sh ps        what is running
#   ./rescue.sh engine    restart the engine container from its published image
#
set -euo pipefail

VOLUME=qanoontech_engine
COMPOSE_IN_VOLUME=docker-compose.generated.yml
ENGINE_IMAGE="${ENGINE_IMAGE:-ghcr.io/alikhubrani/qanoontech-engine:latest}"
ENGINE_NAME="${ENGINE_NAME:-qanoontech-engine}"

# The compose file lives on the engine's volume. Copy it out through a
# throwaway container — this script must not assume the engine can run.
fetch_compose() {
  local dir
  dir=$(mktemp -d)
  docker run --rm -v "$VOLUME":/state:ro busybox cat "/state/$COMPOSE_IN_VOLUME" \
    > "$dir/$COMPOSE_IN_VOLUME" 2>/dev/null \
    || { echo "No rendered compose file on the $VOLUME volume — the engine never deployed here." >&2; exit 1; }
  echo "$dir/$COMPOSE_IN_VOLUME"
}

case "${1:-}" in
  up)
    FILE=$(fetch_compose)
    docker compose --project-name qanoontech --file "$FILE" up -d --remove-orphans
    ;;
  down)
    FILE=$(fetch_compose)
    docker compose --project-name qanoontech --file "$FILE" down --remove-orphans
    ;;
  ps)
    docker compose --project-name qanoontech ps 2>/dev/null || docker ps --filter name=qanoontech
    ;;
  engine)
    docker rm -f "$ENGINE_NAME" 2>/dev/null || true
    docker run -d --name "$ENGINE_NAME" \
      --volume /var/run/docker.sock:/var/run/docker.sock \
      --volume "$VOLUME":/var/lib/qanoontech-engine \
      --publish 127.0.0.1:8081:8080 \
      --restart unless-stopped \
      "$ENGINE_IMAGE"
    echo "Engine restarted on 127.0.0.1:8081."
    ;;
  *)
    echo "Usage: ./rescue.sh up | down | ps | engine" >&2
    exit 1
    ;;
esac
