#!/usr/bin/env bash
# Runs the black-box security checks against a throwaway local Worker: a fresh
# D1 database, a random admin password, `wrangler dev` on its own port. Exits
# non-zero if any check fails.
#
#   PORT=8804          port for the throwaway Worker
#   DB_NAME=...        D1 database name from wrangler.toml (omg-oh-my-glam)
#   SKIP_BROWSER=1     skip the Playwright check
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8804}"
DB_NAME="${DB_NAME:-omg-oh-my-glam}"
BASE_URL="http://127.0.0.1:${PORT}"
mkdir -p .wrangler
STATE="$(mktemp -d .wrangler/e2e-XXXXXX)"
LOG="${STATE}.log"
PASSWORD="e2e-$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))')"
PID=""

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    # wrangler dev runs in its own process group (set -m below), so this also
    # stops the workerd processes it started.
    kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$STATE" "$LOG"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if curl -s -o /dev/null --max-time 2 "$BASE_URL/"; then
  echo "Something is already answering on port ${PORT}. Stop it, or set PORT to a free port." >&2
  exit 2
fi

echo "Applying migrations to a fresh local database in ${STATE}..."
if ! npx wrangler d1 migrations apply "$DB_NAME" --local --persist-to "$STATE" </dev/null >"$LOG" 2>&1; then
  cat "$LOG" >&2
  exit 2
fi

echo "Starting wrangler dev on ${BASE_URL}..."
set -m
WRANGLER_SEND_METRICS=false npx wrangler dev --port "$PORT" --ip 127.0.0.1 --persist-to "$STATE" \
  --var "ADMIN_PASSWORD:${PASSWORD}" </dev/null >>"$LOG" 2>&1 &
PID=$!
set +m

code="000"
for _ in $(seq 1 120); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE_URL/" || true)"
  [[ "$code" != "000" ]] && break
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "wrangler dev exited before answering:" >&2
    cat "$LOG" >&2
    exit 2
  fi
  sleep 0.5
done
if [[ "$code" == "000" ]]; then
  echo "wrangler dev did not answer within 60 seconds:" >&2
  tail -n 40 "$LOG" >&2
  exit 2
fi

export BASE_URL
export ADMIN_PASSWORD="$PASSWORD"
status=0

node e2e/security.mjs || status=1

if [[ "${SKIP_BROWSER:-}" == "1" ]]; then
  echo "SKIP_BROWSER=1: browser check skipped."
else
  node e2e/xss-browser.mjs || status=1
fi

# Last: these use up the day's booking and review budgets and lock the admin
# login for an hour.
node e2e/security.mjs --phase=caps || status=1

if [[ "$status" -ne 0 ]]; then
  echo
  echo "Some checks failed. Last lines of the wrangler log:"
  tail -n 30 "$LOG"
fi
exit "$status"
