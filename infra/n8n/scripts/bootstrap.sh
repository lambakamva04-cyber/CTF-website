#!/usr/bin/env bash
#
# Sets up the whole n8n side of the stack on a fresh Ubuntu 22.04 / 24.04 box.
#
#   1. Sanity-checks the machine (RAM, disk, architecture) and offers swap.
#   2. Installs Docker Engine + the Compose plugin from Docker's own repo.
#   3. Creates .env from the template, generates the encryption key, and locks
#      the file down to 0600.
#   4. Optionally configures ufw to deny inbound traffic (SSH stays open).
#   5. Starts n8n and waits for it to report healthy.
#   6. Pins the exact image digest it installed, so future restarts are
#      reproducible.
#
# Safe to re-run. Every step checks whether it's already been done.
#
# Usage:
#   ./scripts/bootstrap.sh
#   ./scripts/bootstrap.sh --hostname n8n.example.com --timezone Europe/London
#   ./scripts/bootstrap.sh --yes            # no prompts, keep every default
#
# Run as your normal user, not root. It calls sudo where it needs to.
#
# When it finishes, run ./scripts/setup-tunnel.sh to publish it.

set -uo pipefail

ASSUME_YES=0
WANT_HOSTNAME=""
WANT_TIMEZONE=""
SETUP_FIREWALL="ask"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Absolute, so --help still works after the cd below.
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
STACK_DIR=$(dirname "$SCRIPT_DIR")

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); RST=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; RST=""
fi

step()  { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RST"; }
ok()    { printf '  %s✓%s %s\n' "$GRN" "$RST" "$*"; }
skip()  { printf '  %s•%s %s %s(already done)%s\n' "$DIM" "$RST" "$*" "$DIM" "$RST"; }
warn()  { printf '  %s!%s %s\n' "$YEL" "$RST" "$*" >&2; }
die()   { printf '\n  %s✗ %s%s\n\n' "$RED" "$*" "$RST" >&2; exit 1; }

confirm() { # prompt [default-yes]
  [ "$ASSUME_YES" = 1 ] && return 0
  local reply
  printf '\n  %s [y/N] ' "$1"
  read -r reply </dev/tty || return 1
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

ask() { # prompt default -> answer on stdout
  local reply
  if [ "$ASSUME_YES" = 1 ]; then printf '%s' "$2"; return; fi
  printf '  %s [%s]: ' "$1" "$2" >&2
  read -r reply </dev/tty || reply=""
  printf '%s' "${reply:-$2}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --hostname)   WANT_HOSTNAME=${2:-}; shift 2 ;;
    --timezone)   WANT_TIMEZONE=${2:-}; shift 2 ;;
    --firewall)   SETUP_FIREWALL="yes"; shift ;;
    --no-firewall) SETUP_FIREWALL="no"; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    -h|--help)    sed -n '2,30p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "unknown option: $1  (try --help)" ;;
  esac
done

cd "$STACK_DIR" || die "Can't cd to $STACK_DIR"

# --- 1. is this machine up to the job? --------------------------------------
step "1/6  Checking the machine"

[ "$(id -u)" = 0 ] && die "Run this as your normal user, not root.
    Files created here should belong to you, not to root. sudo is called
    where it's actually needed."

command -v sudo >/dev/null 2>&1 || die "sudo is not installed."

if [ -r /etc/os-release ]; then
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:22.04|ubuntu:24.04) ok "Ubuntu $VERSION_ID" ;;
    ubuntu:*) warn "Ubuntu $VERSION_ID — written for 22.04/24.04, will probably work" ;;
    debian:*) warn "Debian ${VERSION_ID:-?} — close enough, but untested here" ;;
    *) warn "${PRETTY_NAME:-unknown OS} — this script expects Ubuntu" ;;
  esac
fi

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
DISK_MB=$(df -Pm . | awk 'NR==2 {print $4}')
ok "RAM ${MEM_MB}MB, swap ${SWAP_MB}MB, free disk ${DISK_MB}MB"

[ "$DISK_MB" -lt 3000 ] && warn "Under 3GB free. Docker images alone want ~1.5GB."

# n8n is Node — it is comfortable in ~700MB and unhappy in 400MB. On the very
# small free tiers, swap is the difference between "slow" and "killed".
if [ "$MEM_MB" -lt 2000 ] && [ "$SWAP_MB" -lt 512 ]; then
  warn "${MEM_MB}MB RAM and almost no swap. n8n will get OOM-killed under load."
  if confirm "Create a 2GB swap file at /swapfile?"; then
    if [ -e /swapfile ]; then
      warn "/swapfile already exists; leaving it alone"
    else
      sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
      sudo chmod 600 /swapfile
      sudo mkswap /swapfile >/dev/null
      sudo swapon /swapfile
      grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
      # Prefer keeping things in RAM; swap is an emergency buffer, not storage.
      sudo sysctl -q vm.swappiness=10
      grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf >/dev/null
      ok "2GB swap active, and it survives a reboot"
    fi
  fi
fi

# --- 2. docker --------------------------------------------------------------
step "2/6  Installing Docker"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  skip "Docker $(docker --version | awk '{print $3}' | tr -d ,) with the compose plugin"
else
  # Ubuntu's own docker.io package ships without the compose plugin, so use
  # Docker's repository instead of apt's default.
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg >/dev/null

  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg \
    || die "Couldn't fetch Docker's signing key. Check outbound HTTPS."
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
       docker-buildx-plugin docker-compose-plugin >/dev/null \
    || die "Docker failed to install. Scroll up for apt's error."

  sudo systemctl enable --now docker >/dev/null 2>&1
  ok "Docker installed and enabled at boot"
fi

# Membership of the docker group is equivalent to root on this box, so it isn't
# granted silently — sudo is used instead unless the user already has it.
if docker info >/dev/null 2>&1; then
  DOCKER="docker"
  ok "you can run docker directly"
else
  DOCKER="sudo docker"
  ok "using sudo for docker"
  printf '  %sTo drop the sudo: sudo usermod -aG docker %s, then log out and back in.\n' "$DIM" "$USER"
  printf '  Be aware that group grants root-equivalent access to this machine.%s\n' "$RST"
fi

# --- 3. .env ----------------------------------------------------------------
step "3/6  Configuration and secrets"

[ -f .env.example ] || die "Missing .env.example — are you running this from the right directory?"

if [ -f .env ]; then
  skip ".env exists (not touching your settings)"
else
  cp .env.example .env
  ok ".env created from the template"
fi

# 0600 before anything sensitive goes in, not after.
chmod 600 .env
ok ".env permissions: $(stat -c '%a %U:%G' .env)"

# git only records the executable bit, so a fresh clone leaves these
# world-readable and world-executable. They run sudo — nobody else on the box
# should be able to read or run them.
chmod 700 "$SCRIPT_DIR"/*.sh
ok "scripts permissions: 700"

env_get() { sed -n "s/^$1=//p" .env | tail -1 | tr -d '"\r' | tr -d "'"; }
env_set() { # key value  — replaces the line in place, preserving position
  local key=$1 value=$2
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

# -- encryption key --
CURRENT_KEY=$(env_get N8N_ENCRYPTION_KEY)
VOLUME_EXISTS=0
$DOCKER volume inspect n8n_data >/dev/null 2>&1 && VOLUME_EXISTS=1

case "$CURRENT_KEY" in
  ""|REPLACE_ME*)
    if [ "$VOLUME_EXISTS" = 1 ]; then
      # Generating a fresh key against an existing database would leave every
      # stored credential permanently undecryptable. Stop instead.
      die "The n8n_data volume already has data, but .env has no encryption key.

    Generating a new key now would make every credential already stored in
    that volume impossible to decrypt.

    If you have the original key, put it in .env as N8N_ENCRYPTION_KEY and
    re-run. If this volume is genuinely disposable, remove it first:

        $DOCKER volume rm n8n_data"
    fi

    if command -v openssl >/dev/null 2>&1; then
      NEW_KEY=$(openssl rand -base64 24)
    else
      NEW_KEY=$(head -c 24 /dev/urandom | base64)
    fi
    env_set N8N_ENCRYPTION_KEY "$NEW_KEY"
    ok "encryption key generated (${#NEW_KEY} characters)"
    printf '\n  %s%sCopy this into your password manager now.%s\n' "$BOLD" "$YEL" "$RST"
    printf '  %sIt is the only thing that can decrypt your stored credentials,\n' "$YEL"
    printf '  and it is not recoverable if this VPS goes away.%s\n\n' "$RST"
    printf '      N8N_ENCRYPTION_KEY=%s%s%s\n' "$BOLD" "$NEW_KEY" "$RST"
    if [ "$ASSUME_YES" != 1 ]; then
      printf '\n  Press Enter once you have saved it. '
      read -r _ </dev/tty || true
    fi
    ;;
  *)
    skip "encryption key already set (${#CURRENT_KEY} characters)"
    [ "${#CURRENT_KEY}" -lt 24 ] && warn "That key is short. 32 characters is the intended length."
    ;;
esac

# -- hostname --
CURRENT_HOST=$(env_get N8N_HOST)
if [ -n "$WANT_HOSTNAME" ]; then
  NEW_HOST="$WANT_HOSTNAME"
elif [ "${CURRENT_HOST}" = "n8n.yourdomain.com" ] && [ "$ASSUME_YES" != 1 ]; then
  printf '\n  The public address n8n will live at. It must be a subdomain of a\n'
  printf '  domain already in your Cloudflare account.\n\n'
  NEW_HOST=$(ask "Hostname" "n8n.yourdomain.com")
else
  NEW_HOST="$CURRENT_HOST"
fi

if [ -n "$NEW_HOST" ] && [ "$NEW_HOST" != "$CURRENT_HOST" ]; then
  env_set N8N_HOST "$NEW_HOST"
  env_set WEBHOOK_URL "https://${NEW_HOST}/"
  env_set N8N_EDITOR_BASE_URL "https://${NEW_HOST}/"
  ok "hostname set to $NEW_HOST (webhook and editor URLs updated to match)"
else
  skip "hostname: ${CURRENT_HOST:-unset}"
fi

case "$(env_get N8N_HOST)" in
  *yourdomain.com*)
    warn "Hostname is still the placeholder. n8n will start, but the tunnel"
    warn "step will refuse to run until you set a real one in .env." ;;
esac

# -- timezone --
if [ -n "$WANT_TIMEZONE" ]; then
  env_set GENERIC_TIMEZONE "$WANT_TIMEZONE"
  env_set TZ "$WANT_TIMEZONE"
  ok "timezone set to $WANT_TIMEZONE"
elif [ -r /etc/timezone ]; then
  HOST_TZ=$(cat /etc/timezone)
  CURRENT_TZ=$(env_get GENERIC_TIMEZONE)
  if [ -n "$HOST_TZ" ] && [ "$HOST_TZ" != "$CURRENT_TZ" ] && [ "$HOST_TZ" != "Etc/UTC" ]; then
    if confirm "This machine's timezone is $HOST_TZ but .env says $CURRENT_TZ. Use $HOST_TZ?"; then
      env_set GENERIC_TIMEZONE "$HOST_TZ"
      env_set TZ "$HOST_TZ"
      ok "timezone set to $HOST_TZ"
    fi
  else
    skip "timezone: ${CURRENT_TZ:-unset}"
  fi
fi

# --- 4. firewall ------------------------------------------------------------
step "4/6  Firewall"

if [ "$SETUP_FIREWALL" = "no" ]; then
  skip "skipped (--no-firewall)"
elif ! command -v ufw >/dev/null 2>&1; then
  skip "ufw isn't installed; nothing to configure"
elif sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
  skip "ufw is already active"
  sudo ufw status numbered 2>/dev/null | sed 's/^/    /'
else
  printf '\n  %sWorth knowing:%s Docker writes its own iptables rules and bypasses ufw.\n' "$BOLD" "$RST"
  printf '  A published port can be reachable from the internet even with ufw set\n'
  printf '  to deny everything. What actually protects n8n here is the 127.0.0.1\n'
  printf '  binding in docker-compose.yml — ufw is a second layer, not the first.\n'

  if [ "$SETUP_FIREWALL" = "yes" ] || confirm "Enable ufw (deny inbound, allow SSH)?"; then
    # SSH first, always. Enabling deny-inbound without this ends the session
    # and locks you out of the box.
    sudo ufw allow OpenSSH >/dev/null 2>&1 || sudo ufw allow 22/tcp >/dev/null
    sudo ufw default deny incoming >/dev/null
    sudo ufw default allow outgoing >/dev/null
    sudo ufw --force enable >/dev/null
    ok "ufw active: inbound denied, SSH allowed"
    warn "Don't close this session until you've confirmed a second SSH login works."
  else
    skip "left alone"
  fi
fi

# --- 5. start n8n -----------------------------------------------------------
step "5/6  Starting n8n"

$DOCKER compose config --quiet || die "docker-compose.yml + .env don't validate. The error is above."
ok "compose file validates"

$DOCKER compose pull --quiet 2>/dev/null || $DOCKER compose pull || die "Couldn't pull the n8n image."
ok "image pulled"

$DOCKER compose up -d || die "Couldn't start the container."

printf '  waiting for n8n to report healthy '
HEALTHY=0
for _ in $(seq 1 60); do
  STATE=$($DOCKER inspect --format '{{.State.Health.Status}}' n8n 2>/dev/null)
  case "$STATE" in
    healthy)   HEALTHY=1; break ;;
    unhealthy) break ;;
  esac
  printf '.'
  sleep 3
done
printf '\n'

if [ "$HEALTHY" = 1 ]; then
  ok "n8n is healthy on 127.0.0.1:$(env_get N8N_PORT)"
else
  $DOCKER compose logs --tail 40 n8n >&2
  die "n8n didn't become healthy within three minutes. Its last 40 log lines are above.
    Common causes: not enough RAM (check 'free -m'), or a bad value in .env."
fi

# --- 6. pin the image -------------------------------------------------------
step "6/6  Pinning the image"

DIGEST=$($DOCKER image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' \
         "$($DOCKER inspect --format '{{.Config.Image}}' n8n 2>/dev/null)" 2>/dev/null)

if [ -n "$DIGEST" ]; then
  env_set N8N_IMAGE "$DIGEST"
  VERSION=$($DOCKER exec n8n n8n --version 2>/dev/null | tail -1)
  ok "pinned to ${VERSION:-this build} by digest"
  printf '  %s%s%s\n' "$DIM" "$DIGEST" "$RST"
  printf '  %sUse ./scripts/update.sh to move to a newer version.%s\n' "$DIM" "$RST"
else
  warn "Couldn't read the image digest; N8N_IMAGE left as-is."
fi

chmod 600 .env

# --- done -------------------------------------------------------------------
cat <<DONE

${BOLD}${GRN}n8n is running.${RST}

  It is listening on 127.0.0.1:$(env_get N8N_PORT) and is ${BOLD}not${RST} reachable from the
  internet yet — which is the correct state to be in right now.

${BOLD}Next${RST}

  ${BOLD}./scripts/setup-tunnel.sh${RST}

  That publishes it at https://$(env_get N8N_HOST) through Cloudflare, still
  without opening a port.

${DIM}  Want to look at it first? From your laptop:
      ssh -L 5678:127.0.0.1:5678 $USER@<this-server>
  then open http://localhost:5678 in your browser.${RST}

DONE
