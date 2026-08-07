# Cut Through Faster

Two deployables live in this repository.

| Directory | What it is | Deploys to |
| --- | --- | --- |
| `ctf-website/public/` | Marketing site — the public `cutthroughfaster.com` page | Cloudflare Pages (`npm run deploy` from the repo root) |
| `app/` | Client control platform — where clients watch their AI receptionist, take calls over, and read transcripts | Cloudflare Workers (`npm run deploy` from `app/`) |

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
```
