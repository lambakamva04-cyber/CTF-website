# n8n behind a Cloudflare Tunnel

Self-hosted n8n on a small Ubuntu VPS, reachable over HTTPS at your own
domain, with **no inbound ports open** — not 443, not 80, not 5678.

```
   browser
      │  https://n8n.yourdomain.com
      ▼
 ┌─────────────────┐
 │ Cloudflare edge │  TLS terminates here. Access checks who you are.
 └────────┬────────┘
          │  the tunnel — established OUTBOUND from your VPS
          ▼
 ┌───────────────────────────── your VPS ─────────────────────────────┐
 │  cloudflared  ──HTTP──▶  127.0.0.1:5678  ──▶  n8n container        │
 │  (systemd, sandboxed)     loopback only        (non-root, no caps) │
 │                                                                    │
 │  ufw: deny all inbound          firewall has nothing to allow      │
 └────────────────────────────────────────────────────────────────────┘
```

The tunnel dials *out* to Cloudflare and traffic comes back down that
connection. That is why nothing has to be opened. It also means a port scan of
your VPS finds SSH and nothing else.

---

## Get it running

Three commands on a fresh Ubuntu 22.04 or 24.04 box. Run them as your normal
user — **not** as root, and not with `sudo`. The scripts call `sudo` themselves
for the handful of steps that genuinely need it.

```bash
git clone <this repo> && cd CTF-website/infra/n8n

./scripts/bootstrap.sh      # 1. Docker, .env, encryption key, start n8n
./scripts/setup-tunnel.sh   # 2. cloudflared, tunnel, DNS, systemd service
./scripts/status.sh         # 3. confirm every part is working
```

`bootstrap.sh` asks you two questions (your hostname, your timezone) and
generates the encryption key itself. `setup-tunnel.sh` asks you to open one
Cloudflare URL in a browser to sign in. Everything else is automatic, and both
scripts are safe to re-run — they skip whatever is already done.

If `make` is installed you can use `make setup`, `make tunnel`, `make status`
instead. `make` on its own lists everything available.

---

## What's in here

| File | What it does |
| --- | --- |
| `docker-compose.yml` | The n8n container: non-root, loopback-only, no capabilities, health-checked, restarts unless you stopped it |
| `.env.example` | Every setting, with the reasoning next to it. Copy to `.env` |
| `scripts/bootstrap.sh` | Installs Docker, writes `.env`, generates the key, starts n8n |
| `scripts/setup-tunnel.sh` | Installs cloudflared, creates the tunnel and DNS record, installs the systemd service |
| `scripts/status.sh` | Checks all of it and prints the fix for anything broken |
| `scripts/backup.sh` | Backs up and restores workflows, credentials and the key |
| `scripts/update.sh` | Updates n8n, with a backup first and automatic rollback |
| `cloudflared/config.template.yml` | Tunnel ingress rules, filled in by `setup-tunnel.sh` |
| `Makefile` | Short names for all of the above |

---

## The one thing you still have to do by hand

When `setup-tunnel.sh` finishes, `https://n8n.yourdomain.com` is live on the
public internet and the only thing guarding it is the n8n login form. That
form is a perfectly good login form, but it is also the entire perimeter, and
n8n instances get found by automated scanners within hours.

Put **Cloudflare Access** in front of it. It's free for up to 50 users and it
means an attacker never even reaches the n8n login page.

1. [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → **Access** → **Applications**
2. **Add an application** → **Self-hosted**
3. Domain: `n8n.yourdomain.com`
4. Policy: **Allow**, Include → **Emails** → your email address

Then — and this part is easy to miss — **add a second application above the
first one** in the list:

5. Same domain, path `webhook` (repeat for `webhook-test`)
6. Policy: **Bypass** → **Everyone**

Without step 5–6, Access sits in front of your webhook URLs too, and every
incoming webhook from Stripe, a form, or another service gets an HTML login
page instead of reaching your workflow. Access evaluates applications in order,
so the bypass rule has to sit above the allow rule.

`./scripts/status.sh` tells you whether Access is active: a `302` or `403` on
the public health check means it's working.

---

## Day to day

```bash
./scripts/status.sh                 # what's broken, and how to fix it
docker compose logs -f n8n          # follow the logs
docker compose restart              # restart n8n
./scripts/backup.sh                 # back up (stops n8n for ~10 seconds)
./scripts/update.sh                 # update, with rollback if it goes wrong
sudo systemctl status cloudflared   # is the tunnel connected
```

To look at n8n before the tunnel exists, forward the port over SSH from your
laptop — no need to expose anything:

```bash
ssh -L 5678:127.0.0.1:5678 you@your-server
# then open http://localhost:5678
```

---

## Two things that will ruin your day if you lose them

**The encryption key** (`N8N_ENCRYPTION_KEY` in `.env`). Every credential you
store in n8n — API keys, OAuth tokens, database passwords — is encrypted with
it. Lose it and they are unrecoverable; there is no reset. `bootstrap.sh`
prints it once and waits for you to save it. Put it in a password manager.

**The `n8n_data` volume.** Workflows, credentials, execution history. Backed up
by `./scripts/backup.sh`, which includes `.env` in the archive so a restore has
the key it needs.

A backup that only lives on the machine it's backing up isn't a backup. Get it
off the box:

```bash
./scripts/backup.sh --encrypt        # AES256, asks for a passphrase
scp you@your-server:~/CTF-website/infra/n8n/backups/n8n-*.gpg ~/backups/
```

Nightly, with the passphrase in a root-only file rather than in the crontab:

```bash
sudo crontab -e
0 3 * * * BACKUP_PASSPHRASE="$(cat /root/.n8n-backup-pass)" \
          /home/YOU/CTF-website/infra/n8n/scripts/backup.sh --encrypt --keep 14
```

---

## Permissions, and why each one

`./scripts/status.sh` verifies all of these; `make perms` re-applies them.

| Path | Mode | Owner | Why |
| --- | --- | --- | --- |
| `.env` | `600` | you | Holds the encryption key |
| `backups/` | `700` | you | Archives contain credentials **and** the key |
| `backups/*.tar.gz` | `600` | you | Same |
| `scripts/*.sh` | `700` | you | They run `sudo`; nobody else should be able to read or edit them. Git can't store `700`, so `bootstrap.sh` re-applies it after a clone |
| `~/.cloudflared/cert.pem` | `600` | you | Authorises creating tunnels and editing DNS on your zone |
| `~/.cloudflared/<uuid>.json` | `600` | you | The tunnel's private key — enough to run your tunnel from anywhere |
| `/etc/cloudflared/` | `700` | `cloudflared` | Same, for the copy the service reads |
| `/etc/cloudflared/*` | `600` | `cloudflared` | Same |
| `~/.n8n/config` (in the volume) | `600` | `node` | n8n refuses to start otherwise — `N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true` |

The container runs as `node` (uid 1000) with `cap_drop: ALL` and
`no-new-privileges`. `cloudflared` runs under its own system account with no
capabilities and a read-only view of `/etc` — if that sandbox ever stops the
service from starting, `setup-tunnel.sh` removes it automatically rather than
leaving your tunnel down, and says so.

---

## One deliberate difference from the obvious setup

You will see `N8N_LISTEN_ADDRESS=127.0.0.1` in a lot of self-hosting guides.
Inside a container it is wrong, and it fails in a confusing way.

`N8N_LISTEN_ADDRESS` is the address n8n binds to *inside its own container*,
which is a private network namespace containing one process. Bind it to
`127.0.0.1` there and Docker's port publisher can't reach it either — the
container starts, never passes its health check, and serves nobody. Meanwhile
it protects nothing, because there was never anything else in that namespace.

So this stack pins it to `0.0.0.0` **inside** the container, and applies the
loopback restriction where it actually does the work — the host side of the
published port:

```yaml
ports:
  - "127.0.0.1:5678:5678"
     ^^^^^^^^^ host: only this machine can reach it
               ^^^^ container: n8n listens here
```

That is also why the firewall isn't the primary control here. Docker writes its
own iptables rules and routinely bypasses `ufw` — a published port can be
reachable from the internet with ufw set to deny everything. The `127.0.0.1`
prefix is what actually keeps n8n off the public internet. ufw is the second
layer, not the first. `status.sh` checks the public interface directly and
fails loudly if anything is answering on it.

---

## When something's wrong

Run `./scripts/status.sh` first — it checks each layer in order and prints the
specific fix for whatever it finds. If you want to reason about it yourself:

| Symptom | Where the problem is | Fix |
| --- | --- | --- |
| Cloudflare **error 1033** or **530** | The edge can't find your tunnel | `sudo systemctl status cloudflared`, then `sudo journalctl -u cloudflared -n 40` |
| **502 / 503** through the tunnel | Tunnel is up, n8n isn't answering | `docker compose ps`, `docker compose logs --tail 50 n8n` |
| Login page appears for a **webhook** | Access is in front of `/webhook` | Add the Bypass application above the Allow one (see above) |
| Tunnel connects then drops every few seconds | Provider is filtering outbound UDP | Set `protocol: http2` in `/etc/cloudflared/config.yml`, then restart it |
| n8n restarting repeatedly | Almost always out of memory | `free -m`; re-run `bootstrap.sh` to add swap, or lower `NODE_OPTIONS` |
| **DNS doesn't resolve** | The record wasn't created | `cloudflared tunnel route dns n8n-tunnel n8n.yourdomain.com` |
| "Settings file permissions are not secure" | The config file inside the volume is too open | `docker compose exec n8n chmod 600 /home/node/.n8n/config` |
| Webhook URLs show `localhost` | `WEBHOOK_URL` isn't set to your domain | Fix it in `.env`, then `docker compose up -d` |

---

## If you outgrow this

The defaults here suit one person on a free-tier box. Worth revisiting when
that stops being true:

- **SQLite → Postgres.** SQLite is fine for a single instance; concurrent
  executions will eventually contend on it. Add a `postgres` service and set
  `DB_TYPE=postgresdb`.
- **Queue mode.** Redis plus separate worker containers, once one process
  can't keep up.
- **Community nodes** are disabled (`N8N_COMMUNITY_PACKAGES_ENABLED=false`).
  They're arbitrary third-party code running with n8n's privileges — turn them
  on per-node, after reading the source.
- **Code node env access** is blocked (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`).
  Leave it blocked: without it, anyone who can edit a workflow can print your
  encryption key to an execution log in one line.
