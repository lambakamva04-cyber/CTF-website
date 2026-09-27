#!/usr/bin/env bash
#
# Backs up everything that can't be recreated: the n8n data volume (workflows,
# encrypted credentials, execution history, the settings file) and .env (which
# holds the key those credentials are encrypted with).
#
# By default n8n is stopped for the few seconds the copy takes. That matters:
# the database is SQLite, and copying it while it's being written produces an
# archive that restores into a corrupt database. Use --hot to skip the stop if
# a few seconds of downtime is worse for you than that risk.
#
# Usage:
#   ./scripts/backup.sh                        # to ./backups
#   ./scripts/backup.sh --dir /mnt/backups
#   ./scripts/backup.sh --encrypt              # AES256, prompts for a passphrase
#   ./scripts/backup.sh --keep 14              # retention, default 7
#   ./scripts/backup.sh --hot                  # don't stop n8n
#   ./scripts/backup.sh --restore <file>       # put a backup back
#
# Nightly at 03:00 — note the passphrase comes from a root-only file so it
# doesn't sit in the crontab:
#   sudo crontab -e
#   0 3 * * * BACKUP_PASSPHRASE="$(cat /root/.n8n-backup-pass)" \
#             /home/USER/CTF-website/infra/n8n/scripts/backup.sh --encrypt --keep 14

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Absolute, so --help still works after the cd below.
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
STACK_DIR=$(dirname "$SCRIPT_DIR")
cd "$STACK_DIR" || exit 1

BACKUP_DIR="$STACK_DIR/backups"
KEEP=7
ENCRYPT=0
HOT=0
RESTORE_FILE=""
VOLUME="n8n_data"

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); RST=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; RST=""
fi
ok()   { printf '  %s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$RST" "$*" >&2; }
die()  { printf '\n  %s✗ %s%s\n\n' "$RED" "$*" "$RST" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)     BACKUP_DIR=${2:-}; shift 2 ;;
    --keep)    KEEP=${2:-7}; shift 2 ;;
    --encrypt) ENCRYPT=1; shift ;;
    --hot)     HOT=1; shift ;;
    --restore) RESTORE_FILE=${2:-}; shift 2 ;;
    -h|--help) sed -n '2,30p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "unknown option: $1" ;;
  esac
done

DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

# Alpine is small and already likely cached; it provides tar and gzip.
HELPER_IMAGE="alpine:3"

# --- restore ----------------------------------------------------------------
if [ -n "$RESTORE_FILE" ]; then
  [ -f "$RESTORE_FILE" ] || die "No such file: $RESTORE_FILE"

  printf '\n  %sThis replaces the entire contents of the %s volume.%s\n' "$BOLD" "$VOLUME" "$RST"
  printf '  Anything currently in n8n that is not in this archive is lost.\n\n'
  printf '  Type RESTORE to continue: '
  read -r reply </dev/tty || reply=""
  [ "$reply" = "RESTORE" ] || die "Cancelled."

  WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
  SOURCE="$RESTORE_FILE"

  case "$RESTORE_FILE" in
    *.gpg)
      command -v gpg >/dev/null 2>&1 || die "This backup is encrypted but gpg isn't installed."
      gpg --quiet --decrypt --output "$WORK/restore.tar.gz" "$RESTORE_FILE" || die "Decryption failed."
      SOURCE="$WORK/restore.tar.gz"
      ok "decrypted" ;;
  esac

  $DOCKER compose stop n8n >/dev/null 2>&1
  ok "n8n stopped"

  tar -xzf "$SOURCE" -C "$WORK" || die "Couldn't read the archive."
  [ -d "$WORK/n8n_data" ] || die "The archive doesn't contain an n8n_data directory."

  $DOCKER run --rm -v "${VOLUME}:/target" -v "$WORK/n8n_data:/source:ro" "$HELPER_IMAGE" \
    sh -c 'rm -rf /target/* /target/.[!.]* 2>/dev/null; cp -a /source/. /target/' \
    || die "Couldn't write into the volume."
  ok "volume restored"

  if [ -f "$WORK/env" ]; then
    printf '\n  The archive also contains a .env (with the encryption key).\n'
    printf '  Restore it over your current .env? [y/N] '
    read -r reply </dev/tty || reply=""
    case "$reply" in
      [yY]*) cp "$WORK/env" "$STACK_DIR/.env"; chmod 600 "$STACK_DIR/.env"; ok ".env restored (0600)" ;;
      *)     cp "$WORK/env" "$STACK_DIR/.env.from-backup"; chmod 600 "$STACK_DIR/.env.from-backup"
             warn "Saved to .env.from-backup instead — compare them before switching."
             warn "If the encryption keys differ, credentials will not decrypt." ;;
    esac
  fi

  $DOCKER compose up -d
  ok "n8n starting again"
  printf '\n  %sRestored.%s Check it with ./scripts/status.sh\n\n' "$GRN" "$RST"
  exit 0
fi

# --- backup -----------------------------------------------------------------
$DOCKER volume inspect "$VOLUME" >/dev/null 2>&1 || die "No '$VOLUME' volume — nothing to back up."

mkdir -p "$BACKUP_DIR"
# Backups contain credentials and the encryption key. Owner-only, always.
chmod 700 "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE="$BACKUP_DIR/n8n-${STAMP}.tar.gz"

PASSPHRASE="${BACKUP_PASSPHRASE:-}"
if [ "$ENCRYPT" = 1 ]; then
  command -v gpg >/dev/null 2>&1 || die "--encrypt needs gpg: sudo apt-get install -y gnupg"
  if [ -z "$PASSPHRASE" ]; then
    printf '  Passphrase for this backup: '; read -rs PASSPHRASE </dev/tty; printf '\n'
    printf '  Again: '; read -rs CONFIRM </dev/tty; printf '\n'
    [ "$PASSPHRASE" = "$CONFIRM" ] || die "Passphrases don't match."
    [ -n "$PASSPHRASE" ] || die "Empty passphrase."
  fi
fi

printf '\n%sBacking up%s\n' "$BOLD" "$RST"

RUNNING=0
if [ "$HOT" = 0 ]; then
  if [ "$($DOCKER inspect --format '{{.State.Running}}' n8n 2>/dev/null)" = "true" ]; then
    RUNNING=1
    $DOCKER compose stop n8n >/dev/null 2>&1
    ok "n8n stopped for a consistent copy"
  fi
else
  warn "--hot: copying a live SQLite database; the archive may not restore cleanly"
fi

# Always bring n8n back, even if the tar below fails.
restart_if_needed() { [ "$RUNNING" = 1 ] && { $DOCKER compose start n8n >/dev/null 2>&1; ok "n8n started again"; }; }
trap restart_if_needed EXIT

WORK=$(mktemp -d)
$DOCKER run --rm -v "${VOLUME}:/source:ro" -v "$WORK:/out" "$HELPER_IMAGE" \
  sh -c 'mkdir -p /out/n8n_data && cp -a /source/. /out/n8n_data/' \
  || { rm -rf "$WORK"; die "Couldn't read the volume."; }

# The encryption key travels with the data; a backup without it is undecryptable.
[ -f "$STACK_DIR/.env" ] && cp "$STACK_DIR/.env" "$WORK/env"

tar -czf "$ARCHIVE" -C "$WORK" . || { rm -rf "$WORK"; die "tar failed."; }
rm -rf "$WORK"
chmod 600 "$ARCHIVE"
ok "archive written: $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1))"

if [ "$ENCRYPT" = 1 ]; then
  printf '%s' "$PASSPHRASE" | gpg --batch --yes --quiet \
      --passphrase-fd 0 --pinentry-mode loopback \
      --symmetric --cipher-algo AES256 --output "${ARCHIVE}.gpg" "$ARCHIVE" \
    || die "Encryption failed; the unencrypted archive is still at $ARCHIVE"
  shred -u "$ARCHIVE" 2>/dev/null || rm -f "$ARCHIVE"
  ARCHIVE="${ARCHIVE}.gpg"
  chmod 600 "$ARCHIVE"
  ok "encrypted with AES256, plaintext archive removed"
fi

# --- retention --------------------------------------------------------------
COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -name 'n8n-*.tar.gz*' -type f | wc -l)
if [ "$COUNT" -gt "$KEEP" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -name 'n8n-*.tar.gz*' -type f -printf '%T@ %p\n' 2>/dev/null \
    | sort -n | head -n "$((COUNT - KEEP))" | cut -d' ' -f2- \
    | while read -r old; do rm -f "$old"; done
  ok "pruned to the newest $KEEP backups"
fi

cat <<DONE

  ${BOLD}${GRN}Backed up.${RST}  $ARCHIVE

  ${BOLD}${YEL}This file is as sensitive as the server itself.${RST} It contains every
  credential you have stored in n8n, plus the key that decrypts them.
  Copy it somewhere off this VPS — a backup that only exists on the machine
  it's backing up isn't a backup.

    ${DIM}# from your laptop
    scp ${USER}@<this-server>:${ARCHIVE} ~/n8n-backups/${RST}

  Restore with:  ./scripts/backup.sh --restore <file>

DONE
