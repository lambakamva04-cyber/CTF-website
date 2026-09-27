#!/usr/bin/env bash
#
# Moves n8n to a newer version, safely.
#
#   1. Takes a backup first.
#   2. Remembers the exact image currently running.
#   3. Pulls the new one and restarts.
#   4. Waits for a healthy status — and if it doesn't come, puts the old image
#      back automatically.
#   5. Re-pins N8N_IMAGE in .env to the new digest.
#
# n8n occasionally ships a database migration that a downgrade can't undo. The
# automatic rollback covers "the new version won't start"; it does not cover
# "the new version started, migrated the database, and then misbehaved". That
# is what the backup in step 1 is for.
#
# Usage:
#   ./scripts/update.sh                 # latest
#   ./scripts/update.sh --tag 1.70.1    # a specific version
#   ./scripts/update.sh --no-backup

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Absolute, so --help still works after the cd below.
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
STACK_DIR=$(dirname "$SCRIPT_DIR")
cd "$STACK_DIR" || exit 1

TAG="latest"
DO_BACKUP=1

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); RST=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; RST=""
fi
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RST"; }
ok()   { printf '  %s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$RST" "$*" >&2; }
die()  { printf '\n  %s✗ %s%s\n\n' "$RED" "$*" "$RST" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)       TAG=${2:-latest}; shift 2 ;;
    --no-backup) DO_BACKUP=0; shift ;;
    -h|--help)   sed -n '2,22p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           die "unknown option: $1" ;;
  esac
done

DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

env_set() {
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}

OLD_IMAGE=$($DOCKER inspect --format '{{.Image}}' n8n 2>/dev/null)
OLD_REF=$($DOCKER inspect --format '{{.Config.Image}}' n8n 2>/dev/null)
OLD_VERSION=$($DOCKER exec n8n n8n --version 2>/dev/null | tail -1)
[ -n "$OLD_IMAGE" ] || die "n8n isn't running, so there's nothing to update. Start it with '$DOCKER compose up -d'."
ok "currently running ${OLD_VERSION:-unknown version}"

if [ "$DO_BACKUP" = 1 ]; then
  step "Backing up first"
  "$SCRIPT_DIR/backup.sh" || die "Backup failed — not updating."
fi

step "Pulling docker.n8n.io/n8nio/n8n:$TAG"
$DOCKER pull "docker.n8n.io/n8nio/n8n:$TAG" || die "Pull failed."

NEW_DIGEST=$($DOCKER image inspect --format '{{index .RepoDigests 0}}' "docker.n8n.io/n8nio/n8n:$TAG" 2>/dev/null)
[ -n "$NEW_DIGEST" ] || die "Couldn't read the digest of the pulled image."

NEW_IMAGE=$($DOCKER image inspect --format '{{.Id}}' "docker.n8n.io/n8nio/n8n:$TAG" 2>/dev/null)
if [ "$NEW_IMAGE" = "$OLD_IMAGE" ]; then
  ok "already on the newest ${TAG} build — nothing to do"
  env_set N8N_IMAGE "$NEW_DIGEST"
  exit 0
fi

step "Restarting on the new image"
env_set N8N_IMAGE "$NEW_DIGEST"
$DOCKER compose up -d || { env_set N8N_IMAGE "$OLD_REF"; die "Couldn't start the new container. .env put back."; }

printf '  waiting for it to report healthy '
HEALTHY=0
for _ in $(seq 1 60); do
  case "$($DOCKER inspect --format '{{.State.Health.Status}}' n8n 2>/dev/null)" in
    healthy) HEALTHY=1; break ;;
  esac
  printf '.'
  sleep 3
done
printf '\n'

if [ "$HEALTHY" != 1 ]; then
  warn "The new version didn't come up healthy. Rolling back."
  $DOCKER compose logs --tail 40 n8n >&2
  env_set N8N_IMAGE "$OLD_REF"
  $DOCKER compose up -d
  sleep 10
  if [ "$($DOCKER inspect --format '{{.State.Health.Status}}' n8n 2>/dev/null)" = "healthy" ]; then
    die "Rolled back to ${OLD_VERSION:-the previous image}, which is healthy again.
    The new version's last 40 log lines are above."
  fi
  die "Rollback also failed. Restore from the backup taken a minute ago:
    ./scripts/backup.sh --restore backups/<newest file>"
fi

NEW_VERSION=$($DOCKER exec n8n n8n --version 2>/dev/null | tail -1)
ok "now running ${NEW_VERSION:-the new build}"
printf '  %s%s%s\n' "$DIM" "$NEW_DIGEST" "$RST"

$DOCKER image prune -f >/dev/null 2>&1 && ok "old image layers cleaned up"

printf '\n  %s%sUpdated %s -> %s%s\n\n' "$BOLD" "$GRN" "${OLD_VERSION:-old}" "${NEW_VERSION:-new}" "$RST"
