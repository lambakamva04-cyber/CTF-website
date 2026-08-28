#!/usr/bin/env bash
#
# Puts n8n on the internet through a Cloudflare Tunnel, without opening a
# single inbound port on this machine.
#
# What it does, in order:
#   1. Installs cloudflared from Cloudflare's apt repository.
#   2. Logs you into Cloudflare (opens a browser link — the one interactive bit).
#   3. Creates a tunnel named n8n-tunnel, if it doesn't already exist.
#   4. Writes /etc/cloudflared/config.yml routing your hostname to n8n.
#   5. Creates the DNS record pointing your hostname at the tunnel.
#   6. Installs cloudflared as a systemd service and enables it at boot.
#
# Everything here is idempotent: run it twice and the second run reports
# "already done" rather than making a mess. If it fails halfway, fix the thing
# it complained about and run it again.
#
# Usage:
#   ./scripts/setup-tunnel.sh                          # reads hostname from ../.env
#   ./scripts/setup-tunnel.sh --hostname n8n.example.com
#   ./scripts/setup-tunnel.sh --hostname n8n.example.com --yes
#
# Options:
#   --hostname <fqdn>     Public hostname, e.g. n8n.example.com
#   --tunnel-name <name>  Default: n8n-tunnel
#   --service <url>       Where to send traffic. Default: http://localhost:5678
#   --protocol <p>        auto | http2 | quic. Default: auto
#   --no-harden-service   Skip the systemd sandboxing drop-in
#   --yes                 Don't ask for confirmation
#
# Run it as your normal user, NOT as root — the Cloudflare login writes a
# certificate into your home directory, and running the whole thing as root
# puts it somewhere you won't find it later. The script calls sudo itself for
# the handful of steps that need it.

set -uo pipefail

TUNNEL_NAME="n8n-tunnel"
SERVICE_URL="http://localhost:5678"
HOSTNAME_FQDN=""
TUNNEL_PROTOCOL="auto"
HARDEN_SERVICE=1
ASSUME_YES=0

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Absolute, so --help still works after the cd below.
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
STACK_DIR=$(dirname "$SCRIPT_DIR")

# --- output helpers ---------------------------------------------------------
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

confirm() { # prompt
  [ "$ASSUME_YES" = 1 ] && return 0
  local reply
  printf '\n  %s [y/N] ' "$1"
  read -r reply </dev/tty || return 1
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# --- arguments --------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --hostname)          HOSTNAME_FQDN=${2:-}; shift 2 ;;
    --tunnel-name)       TUNNEL_NAME=${2:-}; shift 2 ;;
    --service)           SERVICE_URL=${2:-}; shift 2 ;;
    --protocol)          TUNNEL_PROTOCOL=${2:-}; shift 2 ;;
    --no-harden-service) HARDEN_SERVICE=0; shift ;;
    --yes|-y)            ASSUME_YES=1; shift ;;
    -h|--help)           sed -n '2,40p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                   die "unknown option: $1  (try --help)" ;;
  esac
done

# --- preflight --------------------------------------------------------------
step "Checking this machine"

[ "$(id -u)" = 0 ] && die "Run this as your normal user, not root or sudo.
    The Cloudflare login stores a certificate in your home directory; as root
    it lands in /root and the rest of the setup won't find it.
    The script runs sudo itself where it genuinely needs to."

command -v sudo >/dev/null 2>&1 || die "sudo is not installed."
command -v systemctl >/dev/null 2>&1 || die "This system doesn't use systemd, so the service step can't work."
command -v python3 >/dev/null 2>&1 || die "python3 is required (it parses cloudflared's JSON output). Install it with: sudo apt-get install -y python3"

case "$(uname -m)" in
  x86_64|amd64) PKG_ARCH="amd64" ;;
  aarch64|arm64) PKG_ARCH="arm64" ;;
  *) die "Unsupported CPU architecture: $(uname -m). Cloudflare ships amd64 and arm64 builds." ;;
esac
ok "Ubuntu $(. /etc/os-release 2>/dev/null && echo "${VERSION_ID:-?}") on $PKG_ARCH"

# Take the hostname from .env if it wasn't passed, so there's one source of truth.
if [ -z "$HOSTNAME_FQDN" ] && [ -f "$STACK_DIR/.env" ]; then
  # Last assignment wins, quotes and stray carriage returns stripped.
  HOSTNAME_FQDN=$(sed -n 's/^N8N_HOST=//p' "$STACK_DIR/.env" | tail -1 | tr -d '"\r' | tr -d "'" | xargs)
  [ -n "$HOSTNAME_FQDN" ] && ok "Hostname from .env: $HOSTNAME_FQDN"
fi

[ -z "$HOSTNAME_FQDN" ] && die "No hostname. Pass --hostname n8n.example.com, or set N8N_HOST in $STACK_DIR/.env"

case "$HOSTNAME_FQDN" in
  *yourdomain.com*) die "The hostname is still the placeholder ($HOSTNAME_FQDN).
    Edit N8N_HOST in $STACK_DIR/.env, or pass --hostname with your real domain." ;;
  *.*.*|*.*) : ;;
  *) die "'$HOSTNAME_FQDN' doesn't look like a domain name." ;;
esac

# Warn early if n8n isn't up — the tunnel will still install, it just won't have
# anything to talk to yet.
ORIGIN_PORT=${SERVICE_URL##*:}
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 "http://127.0.0.1:${ORIGIN_PORT}/healthz" >/dev/null 2>&1; then
    ok "n8n is answering on 127.0.0.1:${ORIGIN_PORT}"
  else
    warn "Nothing is answering on 127.0.0.1:${ORIGIN_PORT} yet."
    warn "That's fine — the tunnel will start working the moment you run"
    warn "'docker compose up -d' in $STACK_DIR."
  fi
fi

# --- plan -------------------------------------------------------------------
cat <<PLAN

  ${BOLD}Here's what will happen${RST}

    install     cloudflared (apt, from Cloudflare's own repository)
    login       opens a Cloudflare URL in your browser — you pick your domain
    tunnel      create '${TUNNEL_NAME}' (outbound only, no ports opened)
    dns         ${HOSTNAME_FQDN}  ->  this tunnel
    route       ${HOSTNAME_FQDN}  ->  ${SERVICE_URL}
    service     systemd unit, enabled at boot$([ "$HARDEN_SERVICE" = 1 ] && echo ", sandboxed")

  ${DIM}Uses sudo for: apt install, /etc/cloudflared, systemd.${RST}
PLAN

confirm "Go ahead?" || die "Nothing was changed."

# --- 1. install cloudflared -------------------------------------------------
step "1/6  Installing cloudflared"

if command -v cloudflared >/dev/null 2>&1; then
  skip "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}')"
else
  sudo install -m 0755 -d /usr/share/keyrings

  # Cloudflare's signing key. Without signed-by, apt would trust this repo for
  # every package on the system, not just cloudflared.
  if ! curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
       | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null; then
    die "Couldn't download Cloudflare's signing key. Check this box has outbound HTTPS."
  fi
  sudo chmod 0644 /usr/share/keyrings/cloudflare-main.gpg
  ok "signing key installed"

  CODENAME=$(. /etc/os-release && echo "${VERSION_CODENAME:-jammy}")
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared ${CODENAME} main" \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null

  if sudo apt-get update -o Dir::Etc::sourcelist=sources.list.d/cloudflared.list \
        -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 >/dev/null 2>&1 \
     && sudo apt-get install -y cloudflared >/dev/null 2>&1; then
    ok "installed from apt (updates arrive with apt upgrade)"
  else
    # Cloudflare's repo occasionally lags a new Ubuntu codename. Fall back to
    # the release .deb so a fresh 24.04 box isn't a dead end.
    warn "apt repository didn't work for '$CODENAME'; using the release .deb instead"
    sudo rm -f /etc/apt/sources.list.d/cloudflared.list
    TMP_DEB=$(mktemp /tmp/cloudflared.XXXXXX.deb)
    curl -fsSL -o "$TMP_DEB" \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${PKG_ARCH}.deb" \
      || die "Couldn't download the cloudflared .deb either. Check outbound HTTPS."
    sudo dpkg -i "$TMP_DEB" >/dev/null || die "dpkg failed to install cloudflared."
    rm -f "$TMP_DEB"
    warn "Installed directly — 'apt upgrade' will NOT update it. Re-run this script to upgrade."
  fi

  command -v cloudflared >/dev/null 2>&1 || die "cloudflared still isn't on PATH after installing."
  ok "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}')"
fi

CF_DIR="$HOME/.cloudflared"
install -m 0700 -d "$CF_DIR"

# --- 2. log in --------------------------------------------------------------
step "2/6  Connecting to your Cloudflare account"

if [ -f "$CF_DIR/cert.pem" ]; then
  skip "already logged in ($CF_DIR/cert.pem)"
else
  cat <<'LOGIN'

  cloudflared will print a URL. Open it in a browser — on your laptop is fine,
  it doesn't have to be this machine — sign in, and pick the domain you want
  to use. This window will continue on its own once you've done that.

LOGIN
  cloudflared tunnel login || die "Login failed or was cancelled."
  [ -f "$CF_DIR/cert.pem" ] || die "Login finished but no certificate appeared at $CF_DIR/cert.pem"
fi

# cert.pem authorises creating tunnels and editing DNS on your zone. Owner-only.
chmod 600 "$CF_DIR/cert.pem"
ok "account certificate secured (0600)"

# --- 3. create the tunnel ---------------------------------------------------
step "3/6  Creating tunnel '$TUNNEL_NAME'"

tunnel_id_by_name() { # name -> uuid on stdout, empty if absent
  cloudflared tunnel list --output json 2>/dev/null | python3 -c '
import json,sys
want = sys.argv[1]
try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for row in rows or []:
    # Deleted tunnels linger in the list with a deleted_at timestamp.
    if row.get("name") == want and not row.get("deleted_at"):
        print(row.get("id", ""))
        break
' "$1"
}

TUNNEL_ID=$(tunnel_id_by_name "$TUNNEL_NAME")

if [ -n "$TUNNEL_ID" ]; then
  skip "tunnel exists: $TUNNEL_ID"
else
  cloudflared tunnel create "$TUNNEL_NAME" || die "Couldn't create the tunnel."
  TUNNEL_ID=$(tunnel_id_by_name "$TUNNEL_NAME")
  [ -n "$TUNNEL_ID" ] || die "Tunnel was created but its ID couldn't be read back."
  ok "created: $TUNNEL_ID"
fi

CRED_FILE="$CF_DIR/${TUNNEL_ID}.json"
[ -f "$CRED_FILE" ] || die "Tunnel credentials are missing at $CRED_FILE
    This happens if the tunnel was created on a different machine or by a
    different user. Either copy that file here, or delete the tunnel with
    'cloudflared tunnel delete $TUNNEL_NAME' and run this script again."

# This file is the tunnel's private key — it is enough on its own to run this
# tunnel from anywhere in the world.
chmod 600 "$CRED_FILE"
ok "tunnel credentials secured (0600)"

# --- 4. write the config ----------------------------------------------------
step "4/6  Writing /etc/cloudflared/config.yml"

TEMPLATE="$STACK_DIR/cloudflared/config.template.yml"
[ -f "$TEMPLATE" ] || die "Missing template: $TEMPLATE"

RENDERED=$(mktemp)
trap 'rm -f "$RENDERED"' EXIT

sed -e "s|__TUNNEL_ID__|${TUNNEL_ID}|g" \
    -e "s|__TUNNEL_NAME__|${TUNNEL_NAME}|g" \
    -e "s|__HOSTNAME__|${HOSTNAME_FQDN}|g" \
    -e "s|__SERVICE_URL__|${SERVICE_URL}|g" \
    -e "s|__PROTOCOL__|${TUNNEL_PROTOCOL}|g" \
    -e "s|__CREDENTIALS_FILE__|/etc/cloudflared/${TUNNEL_ID}.json|g" \
    "$TEMPLATE" > "$RENDERED"

# 0700 root:root — the directory holds the tunnel's private key.
sudo install -o root -g root -m 0700 -d /etc/cloudflared
sudo install -o root -g root -m 0600 "$RENDERED" /etc/cloudflared/config.yml
sudo install -o root -g root -m 0600 "$CRED_FILE" "/etc/cloudflared/${TUNNEL_ID}.json"
ok "config and credentials installed, root-owned, 0600"

if ! cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate >/dev/null 2>&1; then
  sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate \
    || die "The generated config was rejected by cloudflared (see the error above)."
fi
ok "ingress rules validated"

# --- 5. DNS -----------------------------------------------------------------
step "5/6  Pointing $HOSTNAME_FQDN at the tunnel"

ROUTE_OUT=$(cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_FQDN" 2>&1)
ROUTE_RC=$?

if [ $ROUTE_RC -eq 0 ]; then
  ok "DNS record created (proxied CNAME -> ${TUNNEL_ID}.cfargotunnel.com)"
elif echo "$ROUTE_OUT" | grep -qi 'already exists\|record with that host'; then
  # A stale A record from an older setup is the usual cause, and it will
  # silently shadow the tunnel, so this is worth being explicit about.
  warn "A DNS record for $HOSTNAME_FQDN already exists."
  if confirm "Overwrite it so it points at this tunnel?"; then
    cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$HOSTNAME_FQDN" \
      || die "Couldn't overwrite the DNS record. Fix it in the Cloudflare dashboard: DNS -> Records."
    ok "DNS record replaced"
  else
    warn "Left alone. If $HOSTNAME_FQDN doesn't load later, this is why."
  fi
else
  printf '%s\n' "$ROUTE_OUT" >&2
  die "Couldn't create the DNS record. The usual cause is that $HOSTNAME_FQDN
    belongs to a zone this Cloudflare account doesn't control, or you picked a
    different domain during login than the one in the hostname."
fi

# --- 6. run it as a service -------------------------------------------------
step "6/6  Installing the systemd service"

if systemctl list-unit-files 2>/dev/null | grep -q '^cloudflared\.service'; then
  skip "service already installed"
else
  sudo cloudflared --config /etc/cloudflared/config.yml service install \
    || die "'cloudflared service install' failed."
  ok "systemd unit created"
fi

if [ "$HARDEN_SERVICE" = 0 ] && [ -f /etc/systemd/system/cloudflared.service.d/10-hardening.conf ]; then
  # --no-harden-service on a box that was hardened before. Undo it properly:
  # leaving the drop-in in place while the files above are now root-owned
  # would give a service that can't read its own credentials.
  sudo rm -f /etc/systemd/system/cloudflared.service.d/10-hardening.conf
  sudo chown -R root:root /etc/cloudflared
  ok "sandbox removed (--no-harden-service); service will run as root"
fi

if [ "$HARDEN_SERVICE" = 1 ]; then
  # The stock unit runs cloudflared as root with the full capability set. It
  # needs neither: it makes outbound TLS connections and reads two files.
  if ! id -u cloudflared >/dev/null 2>&1; then
    sudo useradd --system --no-create-home --shell /usr/sbin/nologin cloudflared \
      || warn "Couldn't create the 'cloudflared' service user; staying as root."
  fi

  if id -u cloudflared >/dev/null 2>&1; then
    sudo chown -R cloudflared:cloudflared /etc/cloudflared
    sudo chmod 0700 /etc/cloudflared
    sudo find /etc/cloudflared -type f -exec chmod 0600 {} +

    sudo install -o root -g root -m 0755 -d /etc/systemd/system/cloudflared.service.d
    sudo tee /etc/systemd/system/cloudflared.service.d/10-hardening.conf >/dev/null <<'UNIT'
# Written by setup-tunnel.sh.
#
# cloudflared opens outbound connections and reads two files. It has no reason
# to be root, to keep any capability, or to be able to see /home. If this ever
# blocks something you need, delete this file and `systemctl daemon-reload`.
#
# Expect one harmless line in the journal because of this:
#   "ICMP proxy feature is disabled"
# That feature needs raw sockets, which need CAP_NET_RAW. It is only used for
# pinging through the tunnel from WARP clients; HTTP traffic is unaffected.
[Service]
User=cloudflared
Group=cloudflared

NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictSUIDSGID=true
LockPersonality=true

ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ReadOnlyPaths=/etc/cloudflared

# AF_NETLINK is needed: cloudflared is a Go program, and Go enumerates network
# interfaces over netlink at startup.
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=true
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
UNIT
    ok "sandboxed: runs as 'cloudflared', no capabilities, /etc read-only"
  fi
fi

sudo systemctl daemon-reload
sudo systemctl enable cloudflared >/dev/null 2>&1 && ok "enabled at boot"
sudo systemctl restart cloudflared

# Give it a moment to either connect or fall over.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  systemctl is-active --quiet cloudflared && break
  sleep 1
done

if ! systemctl is-active --quiet cloudflared; then
  if [ -f /etc/systemd/system/cloudflared.service.d/10-hardening.conf ]; then
    # Don't leave the tunnel down for the sake of the sandbox — back it out,
    # get the service running, and say so plainly.
    warn "The service didn't start with the sandbox applied. Removing it and retrying."
    sudo rm -f /etc/systemd/system/cloudflared.service.d/10-hardening.conf
    sudo chown -R root:root /etc/cloudflared
    sudo systemctl daemon-reload
    sudo systemctl restart cloudflared
    sleep 3
    systemctl is-active --quiet cloudflared \
      && warn "Running unsandboxed (as root). Please report this — see journalctl -u cloudflared."
  fi
fi

systemctl is-active --quiet cloudflared || {
  sudo journalctl -u cloudflared -n 30 --no-pager >&2
  die "cloudflared is installed but not running. The last 30 log lines are above."
}
ok "cloudflared is running"

# --- done -------------------------------------------------------------------
cat <<DONE

${BOLD}${GRN}Tunnel is up.${RST}

  ${BOLD}https://${HOSTNAME_FQDN}${RST}

  DNS can take a minute or two the first time. If you get a Cloudflare 1033
  error, the tunnel is still connecting — wait 60 seconds and reload.

${BOLD}${YEL}One thing left, and it matters${RST}

  That URL is now on the public internet, and the only thing between the world
  and your workflows is the n8n login form. Put Cloudflare Access in front of
  it — it's free for up to 50 users and takes about three minutes:

    1. https://one.dash.cloudflare.com  ->  Access  ->  Applications
    2. Add an application  ->  Self-hosted
    3. Domain: ${HOSTNAME_FQDN}
    4. Policy: Allow, include -> Emails -> your email address
    5. ${BOLD}Then add a second application, ordered above the first:${RST}
       path ${BOLD}webhook${RST} (and ${BOLD}webhook-test${RST}), policy Bypass -> Everyone
       ${DIM}Without this, Access would sit in front of your webhook URLs too and
       every incoming webhook would get a login page instead of your workflow.${RST}

  After that, reaching the n8n login page requires passing Cloudflare's
  identity check first, and your webhooks keep working.

${BOLD}Useful commands${RST}

  sudo systemctl status cloudflared     is the tunnel healthy
  sudo journalctl -u cloudflared -f     follow its logs
  ./scripts/status.sh                   check the whole stack at once
  cloudflared tunnel info ${TUNNEL_NAME}      which edge servers it's connected to

DONE
