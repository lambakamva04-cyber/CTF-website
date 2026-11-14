# Security checks

Run `bash e2e/run.sh` from `omg-website/`. It starts a throwaway Worker (fresh local database, random admin password, port 8804), runs `security.mjs`, the browser check `xss-browser.mjs`, and then the global-cap checks, and exits non-zero if anything failed.
To test a Worker you started yourself: `BASE_URL=http://127.0.0.1:8787 ADMIN_PASSWORD=... node e2e/security.mjs`. Give it a fresh database: the suite uses up rate-limit and daily budgets, and `--phase=caps` locks the admin login for an hour.
The browser check needs Playwright with Chromium. `SKIP_BROWSER=1 bash e2e/run.sh` skips it.
