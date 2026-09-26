#!/usr/bin/env bash
#
# One command that answers "is this thing working, and if not, which part
# broke?" — checks the container, the loopback binding, the tunnel, DNS, and
# the public URL, then tells you what to do about anything it finds.
#
# Usage:  ./scripts/status.sh

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STACK_DIR=$(dirname "$SCRIPT_DIR")
cd "$STACK_DIR" || exit 1

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); RST=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; RST=""
fi

PROBLEMS=0
pass() { printf '  %s✓%s %-34s %s\n' "$GRN" "$RST" "$1" "${2:-}"; }
fail() { printf '  %s✗%s %-34s %s\n' "$RED" "$RST" "$1" "${2:-}"; PROBLEMS=$((PROBLEMS+1)); }
note() { printf '  %s•%s %-34s %s\n' "$DIM" "$RST" "$1" "${2:-}"; }
hint() { printf '      %s-> %s%s\n' "$YEL" "$*" "$RST"; }

env_get() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -1 | tr -d '"\r' | tr -d "'"; }

DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

HOST=$(env_get N8N_HOST)
PORT=$(env_get N8N_PORT); PORT=${PORT:-5678}

printf '\n%sn8n stack%s  %s%s%s\n\n' "$BOLD" "$RST" "$DIM" "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$RST"

# --- configuration ----------------------------------------------------------
printf '%sConfiguration%s\n' "$BOLD" "$RST"

if [ -f .env ]; then
  PERMS=$(stat -c '%a' .env)
  if [ "$PERMS" = "600" ]; then
    pass ".env permissions" "$PERMS $(stat -c '%U:%G' .env)"
  else
    fail ".env permissions" "$PERMS — should be 600"
    hint "chmod 600 .env"
  fi

  KEY=$(env_get N8N_ENCRYPTION_KEY)
  case "$KEY" in
    ""|REPLACE_ME*) fail "encryption key" "not set"
                    hint "run ./scripts/bootstrap.sh" ;;
    *)              pass "encryption key" "set, ${#KEY} characters" ;;
  esac

  case "$HOST" in
    ""|*yourdomain.com*) fail "hostname" "${HOST:-unset} — still a placeholder"
                         hint "set N8N_HOST in .env" ;;
    *)                   pass "hostname" "$HOST" ;;
  esac
else
  fail ".env" "missing"
  hint "run ./scripts/bootstrap.sh"
fi

# --- container --------------------------------------------------------------
printf '\n%sContainer%s\n' "$BOLD" "$RST"

STATE=$($DOCKER inspect --format '{{.State.Status}}' n8n 2>/dev/null)
if [ -z "$STATE" ]; then
  fail "n8n container" "does not exist"
  hint "$DOCKER compose up -d"
else
  HEALTH=$($DOCKER inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no healthcheck{{end}}' n8n 2>/dev/null)
  case "$HEALTH" in
    healthy)   pass "n8n container" "$STATE, $HEALTH" ;;
    starting)  note "n8n container" "$STATE, $HEALTH — give it a minute" ;;
    *)         fail "n8n container" "$STATE, $HEALTH"
               hint "$DOCKER compose logs --tail 50 n8n" ;;
  esac

  RESTARTS=$($DOCKER inspect --format '{{.RestartCount}}' n8n 2>/dev/null)
  [ "${RESTARTS:-0}" -gt 3 ] && { fail "restart count" "$RESTARTS — something is crashing it"
                                  hint "$DOCKER compose logs --tail 80 n8n | grep -i 'error\|killed'"; }

  # A container that runs as root is a container that lost its non-root setting.
  CUSER=$($DOCKER inspect --format '{{.Config.User}}' n8n 2>/dev/null)
  if [ "$CUSER" = "node" ] || [ "$CUSER" = "1000" ]; then
    pass "running as" "$CUSER (non-root)"
  else
    fail "running as" "${CUSER:-root} — expected 'node'"
  fi

  # shellcheck disable=SC2016  # Go template, not a shell expansion
  BINDING=$($DOCKER inspect --format '{{range $p, $c := .NetworkSettings.Ports}}{{range $c}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' n8n 2>/dev/null | xargs)
  case "$BINDING" in
    127.0.0.1:*) pass "port binding" "$BINDING (loopback only)" ;;
    "")          note "port binding" "no published ports" ;;
    *)           fail "port binding" "$BINDING — EXPOSED TO THE INTERNET"
                 hint "set N8N_BIND_ADDRESS=127.0.0.1 in .env, then $DOCKER compose up -d" ;;
  esac

  IMG=$($DOCKER inspect --format '{{.Config.Image}}' n8n 2>/dev/null)
  case "$IMG" in
    *@sha256:*) pass "image" "pinned by digest" ;;
    *)          note "image" "$IMG (tag, not digest)" ;;
  esac

  VERSION=$($DOCKER exec n8n n8n --version 2>/dev/null | tail -1)
  [ -n "$VERSION" ] && note "n8n version" "$VERSION"
fi

# --- reachability on the box ------------------------------------------------
printf '\n%sLocal reachability%s\n' "$BOLD" "$RST"

if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  pass "http://127.0.0.1:${PORT}/healthz" "200 OK"
else
  fail "http://127.0.0.1:${PORT}/healthz" "no answer"
  hint "$DOCKER compose ps"
fi

# The public interface must NOT answer. If it does, the binding is wrong.
PUBLIC_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "127.0.0.1" ]; then
  if curl -fsS --max-time 3 "http://${PUBLIC_IP}:${PORT}/healthz" >/dev/null 2>&1; then
    fail "http://${PUBLIC_IP}:${PORT}" "ANSWERING — n8n is exposed directly"
    hint "check 'ports:' in docker-compose.yml; the host side must be 127.0.0.1"
  else
    pass "public interface :${PORT}" "closed, as intended"
  fi
fi

# --- tunnel -----------------------------------------------------------------
printf '\n%sCloudflare tunnel%s\n' "$BOLD" "$RST"

if ! command -v cloudflared >/dev/null 2>&1; then
  fail "cloudflared" "not installed"
  hint "./scripts/setup-tunnel.sh"
else
  note "cloudflared" "$(cloudflared --version 2>/dev/null | awk '{print $3}')"

  if systemctl is-active --quiet cloudflared 2>/dev/null; then
    SINCE=$(systemctl show cloudflared -p ActiveEnterTimestamp --value 2>/dev/null)
    pass "cloudflared service" "running since ${SINCE:-?}"
    if systemctl is-enabled --quiet cloudflared 2>/dev/null; then
      pass "starts at boot" "enabled"
    else
      fail "starts at boot" "disabled"
      hint "sudo systemctl enable cloudflared"
    fi

    RUNAS=$(systemctl show cloudflared -p User --value 2>/dev/null)
    note "service user" "${RUNAS:-root}"
  else
    fail "cloudflared service" "not running"
    hint "sudo systemctl status cloudflared; sudo journalctl -u cloudflared -n 40"
  fi

  if [ -d /etc/cloudflared ]; then
    DPERM=$(stat -c '%a' /etc/cloudflared)
    if [ "$DPERM" = "700" ]; then
      pass "/etc/cloudflared" "$DPERM $(stat -c '%U:%G' /etc/cloudflared)"
    else
      fail "/etc/cloudflared" "$DPERM — should be 700"
      hint "sudo chmod 700 /etc/cloudflared"
    fi

    # -n so this never blocks on a password prompt (this script is safe to
    # run from cron). If sudo would need one, the check is simply skipped.
    LOOSE=$(sudo -n find /etc/cloudflared -maxdepth 1 -type f -name '*.json' ! -perm 600 2>/dev/null | wc -l)
    if [ "${LOOSE:-0}" -eq 0 ]; then
      pass "tunnel credentials" "0600"
    else
      fail "tunnel credentials" "$LOOSE file(s) not 0600"
      hint "sudo chmod 600 /etc/cloudflared/*.json"
    fi
  fi

  if curl -fsS --max-time 3 http://127.0.0.1:20241/ready >/dev/null 2>&1; then
    pass "tunnel readiness endpoint" "ready"
  else
    note "tunnel readiness endpoint" "no answer on :20241"
  fi
fi

# --- public -----------------------------------------------------------------
if [ -n "$HOST" ] && [ "${HOST#*yourdomain}" = "$HOST" ]; then
  printf '\n%sPublic%s\n' "$BOLD" "$RST"

  RESOLVED=$(getent hosts "$HOST" 2>/dev/null | awk '{print $1}' | paste -sd, -)
  if [ -n "$RESOLVED" ]; then
    pass "DNS for $HOST" "$RESOLVED"
  else
    fail "DNS for $HOST" "does not resolve"
    hint "cloudflared tunnel route dns n8n-tunnel $HOST"
  fi

  CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 12 "https://${HOST}/healthz" 2>/dev/null)
  case "$CODE" in
    200)     pass "https://${HOST}/healthz" "200"
             printf '      %sReachable and unauthenticated. Cloudflare Access is what\n' "$YEL"
             printf '      should be gating this — see the README.%s\n' "$RST" ;;
    302|403) pass "https://${HOST}/healthz" "$CODE — Cloudflare Access is in front" ;;
    530|000) fail "https://${HOST}/healthz" "$CODE — edge can't reach the tunnel"
             hint "sudo systemctl status cloudflared" ;;
    502|503) fail "https://${HOST}/healthz" "$CODE — tunnel is up, n8n isn't answering"
             hint "$DOCKER compose ps" ;;
    *)       fail "https://${HOST}/healthz" "${CODE:-no response}" ;;
  esac
fi

# --- resources --------------------------------------------------------------
printf '\n%sResources%s\n' "$BOLD" "$RST"

MEM_LINE=$(free -m | awk '/^Mem:/ {printf "%dMB used of %dMB", $3, $2}')
SWAP_LINE=$(free -m | awk '/^Swap:/ {printf "%dMB of %dMB", $3, $2}')
note "memory" "$MEM_LINE"
note "swap" "$SWAP_LINE"

DISK_PCT=$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [ "${DISK_PCT:-0}" -ge 85 ]; then
  fail "disk /" "${DISK_PCT}% full"
  hint "$DOCKER system prune -af   # removes unused images and build cache"
else
  note "disk /" "${DISK_PCT}% full, $(df -Ph / | awk 'NR==2 {print $4}') free"
fi

VOL_SIZE=$($DOCKER run --rm -v n8n_data:/d:ro busybox du -sh /d 2>/dev/null | awk '{print $1}')
[ -n "$VOL_SIZE" ] && note "n8n_data volume" "$VOL_SIZE"

# --- verdict ----------------------------------------------------------------
if [ "$PROBLEMS" -eq 0 ]; then
  printf '\n%s%sEverything checks out.%s\n\n' "$BOLD" "$GRN" "$RST"
else
  printf '\n%s%s%d problem(s) found%s — the -> lines above are the fixes.\n\n' "$BOLD" "$RED" "$PROBLEMS" "$RST"
  exit 1
fi
