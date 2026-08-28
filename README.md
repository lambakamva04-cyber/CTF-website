# Cut Through Faster

Three deployables live in this repository.

| Directory | What it is | Deploys to |
| --- | --- | --- |
| `ctf-website/public/` | Marketing site — the public `cutthroughfaster.com` page | Cloudflare Pages (`npm run deploy` from the repo root) |
| `app/` | Client control platform — where clients watch their AI receptionist, take calls over, and read transcripts | Cloudflare Workers (`npm run deploy` from `app/`) |
| `infra/n8n/` | Self-hosted n8n for back-office automation, published through a Cloudflare Tunnel with no inbound ports open | Your own Ubuntu VPS ([runbook](infra/n8n/README.md)) |

The control platform is the product clients log into. It has its own
[README](app/README.md) covering the deploy runbook, how to connect a client's
Vapi assistant, and the security model.

## Quick reference

```bash
# Marketing site
npm install
npm run deploy

# Control platform
cd app
npm install
npm run dev:worker    # API on :8787
npm run dev           # dashboard on :5173
npm test
npm run deploy

# Automation host (on the VPS, not here)
cd infra/n8n
./scripts/bootstrap.sh      # Docker, .env, encryption key, start n8n
./scripts/setup-tunnel.sh   # cloudflared, tunnel, DNS, systemd service
./scripts/status.sh         # check every layer, with the fix for anything broken
```
