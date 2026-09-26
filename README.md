# Cut Through Faster

Four deployables live in this repository.

| Directory | What it is | Deploys to |
| --- | --- | --- |
| `ctf-website/public/` | Marketing site — the public `cutthroughfaster.com` page | Cloudflare Pages (`npm run deploy` from the repo root) |
| `app/` | Client control platform — where clients watch their AI receptionist, take calls over, and read transcripts | Cloudflare Workers (`npm run deploy` from `app/`) |
| `demo/` | Personalised demo pages — one link per cold-email prospect, who talks to Hope live in the browser | Cloudflare Workers (`npm run deploy` from `demo/`) |
| `infra/n8n/` | Self-hosted n8n for back-office automation, published through a Cloudflare Tunnel with no inbound ports open | Your own Ubuntu VPS ([runbook](infra/n8n/README.md)) |

The control platform is the product clients log into. It has its own
[README](app/README.md) covering the deploy runbook, how to connect a client's
Vapi assistant, and the security model.

The demo pages are the top of the funnel: a cold email carries one link, the
prospect taps one button and talks to Hope, already primed with their practice's
details. Its [README](demo/README.md) covers the single-assistant rule, the
spend caps and how to read the click-to-talk numbers.

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

# Demo pages
cd demo
npm install
npm run dev           # demo on :3000
npm run seed          # a test prospect to open
npm run preview       # the real Worker, under wrangler
npm run deploy

# Automation host (on the VPS, not here)
cd infra/n8n
./scripts/bootstrap.sh      # Docker, .env, encryption key, start n8n
./scripts/setup-tunnel.sh   # cloudflared, tunnel, DNS, systemd service
./scripts/status.sh         # check every layer, with the fix for anything broken
```
