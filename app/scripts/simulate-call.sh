#!/usr/bin/env bash
#
# Drives a complete call through the dashboard without a phone line.
#
# Posts the same three webhooks Vapi sends for a real call — status-update,
# transcript, end-of-call-report — so the live panel, the transcript, the
# outcome and the metrics can all be seen working end to end. Useful for
# verifying a fresh deployment, and for demonstrating the product to a client
# before their number is live.
#
# Usage:
#   ./scripts/simulate-call.sh <base-url> <webhook-secret> [assistant-id]
#
#   ./scripts/simulate-call.sh https://app.cutthroughfaster.com "$SECRET"
#
# Open the dashboard alongside it and watch the call arrive.

set -uo pipefail

BASE=${1:-}
SECRET=${2:-}
ASSISTANT=${3:-asst_ctf_demo}

if [ -z "$BASE" ] || [ -z "$SECRET" ]; then
  cat >&2 <<'USAGE'
usage: simulate-call.sh <base-url> <webhook-secret> [assistant-id]

  base-url        e.g. https://app.cutthroughfaster.com
  webhook-secret  the value of VAPI_WEBHOOK_SECRET
  assistant-id    must match organizations.vapi_assistant_id
                  (default: asst_ctf_demo)
USAGE
  exit 1
fi

WEBHOOK="$BASE/api/vapi/webhook"
CALL_ID="call_sim_$(date +%s)"
CALLER_NAME="Thabo Nkosi"
CALLER_NUMBER="+27821234567"

now_ms()  { echo "$(date +%s)000"; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

post() { # description json
  local description=$1 body=$2 response
  response=$(curl -sS --max-time 15 -X POST "$WEBHOOK" \
    -H 'content-type: application/json' \
    -H "Authorization: Bearer $SECRET" \
    -d "$body" 2>&1)

  if echo "$response" | grep -q '"ok":true'; then
    printf '  ✓ %s\n' "$description"
  else
    printf '  ✗ %s\n    %s\n' "$description" "${response:0:300}" >&2
    # A rejected first webhook means the secret or the assistant id is wrong;
    # continuing would just print the same failure five more times.
    exit 1
  fi
}

say() { # role text
  post "$1 says: $2" "$(cat <<JSON
{"message":{"type":"transcript","role":"$1","transcriptType":"final",
"transcript":"$2","timestamp":$(now_ms),"call":{"id":"$CALL_ID"}}}
JSON
)"
}

echo "Simulating a call to $BASE"
echo "  call id:   $CALL_ID"
echo "  assistant: $ASSISTANT"
echo

echo "1. Call comes in"
post "call started" "$(cat <<JSON
{"message":{"type":"status-update","status":"in-progress","timestamp":$(now_ms),
"call":{"id":"$CALL_ID","assistantId":"$ASSISTANT",
"customer":{"number":"$CALLER_NUMBER","name":"$CALLER_NAME"},
"monitor":{"controlUrl":"https://example.invalid/control"},
"startedAt":"$(now_iso)"}}}
JSON
)"

echo
echo "2. Conversation — open the dashboard now, lines appear as they are sent"
sleep 2
say assistant "Good afternoon, thanks for calling. This is Hope, how can I help?"
sleep 3
say user "Hi, I would like to book a cleaning appointment for next week."
sleep 3
say assistant "Of course. Wednesday at 2:30pm is open, would that suit you?"
sleep 3
say user "Yes, Wednesday works well."
sleep 3
say assistant "Perfect, you are booked for Wednesday at 2:30pm. You will get a confirmation SMS shortly."
sleep 2

echo
echo "3. Call ends and is written up"
post "call ended, booking recorded" "$(cat <<JSON
{"message":{"type":"end-of-call-report","endedReason":"hangup","timestamp":$(now_ms),
"call":{"id":"$CALL_ID","assistantId":"$ASSISTANT","endedAt":"$(now_iso)"},
"analysis":{"summary":"Caller booked a cleaning for Wednesday at 2:30pm.",
"structuredData":{"outcome":"booked","service":"Check-up & Cleaning",
"bookingWhen":"Wed, 2:30pm","callerName":"$CALLER_NAME"}},
"artifact":{"messages":[]}}}
JSON
)"

echo
echo "Done. The call should now appear under Recent Activity as a booking,"
echo "and today's Calls Taken and Booking Rate should have moved."
echo
echo "Note: Take Over is not exercised here — a simulated call has no real"
echo "control endpoint behind it, so a transfer would have nothing to ring."
