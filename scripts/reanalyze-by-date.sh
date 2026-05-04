#!/usr/bin/env bash
# Re-analyzes already-analyzed conversations whose intercom_created_at falls
# in a date window, under the currently active prompt. Use this after editing
# the active prompt to refresh today's (or any window's) verdicts.
#
# Drives /api/admin/reanalyze-by-date in a loop until `remaining` hits 0.
# Each call processes up to LIMIT conversations (default 10) at ~15s spacing
# to fit gpt-4o's 30k TPM cap.
#
# Required env var:
#   CRON_SECRET — production secret (Vercel → Settings → Environment Variables)
# Optional env vars (with defaults):
#   APP_URL    = https://ai-chat-qa-tool.vercel.app
#   FROM_DATE  = today 00:00:00 UTC
#   TO_DATE    = today 23:59:59 UTC
#   CUTOFF     = current time at script start (so just-processed rows drop out)
#   LIMIT      = 10                            (max 16; sized for the 300s timeout)
#   PAUSE      = 3                             (seconds between iterations)
#
# Usage (defaults to today's window):
#   export CRON_SECRET=<paste from Vercel>
#   ./scripts/reanalyze-by-date.sh
#
# Stop anytime with Ctrl-C.

set -euo pipefail

if [ -z "${CRON_SECRET:-}" ]; then
  echo "CRON_SECRET env var is required. Set it with: export CRON_SECRET=..." >&2
  exit 1
fi

APP_URL="${APP_URL:-https://ai-chat-qa-tool.vercel.app}"
TODAY_UTC="$(date -u +%Y-%m-%d)"
FROM_DATE="${FROM_DATE:-${TODAY_UTC}T00:00:00Z}"
TO_DATE="${TO_DATE:-${TODAY_UTC}T23:59:59Z}"
CUTOFF="${CUTOFF:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
LIMIT="${LIMIT:-10}"
PAUSE="${PAUSE:-3}"

ENDPOINT="${APP_URL}/api/admin/reanalyze-by-date?fromDate=${FROM_DATE}&toDate=${TO_DATE}&cutoff=${CUTOFF}&limit=${LIMIT}"

echo "Reanalyzing conversations in date window:"
echo "  fromDate: ${FROM_DATE}"
echo "  toDate:   ${TO_DATE}"
echo "  cutoff:   ${CUTOFF}  (re-runs analyses before this)"
echo "  limit:    ${LIMIT} per call"
echo "  pause:    ${PAUSE}s between calls"
echo

iteration=0
total_analyzed=0
total_failed=0

while true; do
  iteration=$((iteration + 1))
  response=$(curl -sS -X POST "$ENDPOINT" -H "Authorization: Bearer ${CRON_SECRET}")

  if command -v jq >/dev/null 2>&1; then
    remaining=$(echo "$response" | jq -r '.remaining // "null"')
    processed=$(echo "$response" | jq -r '.processed // 0')
    analyzed=$(echo "$response"  | jq -r '.analyzed  // 0')
    failed=$(echo "$response"    | jq -r '.failed    // 0')
    done_flag=$(echo "$response" | jq -r '.done // false')
  else
    remaining=$(echo "$response" | grep -oE '"remaining":[0-9]+' | head -1 | cut -d: -f2)
    processed=$(echo "$response" | grep -oE '"processed":[0-9]+' | head -1 | cut -d: -f2)
    analyzed=$(echo "$response"  | grep -oE '"analyzed":[0-9]+'  | head -1 | cut -d: -f2)
    failed=$(echo "$response"    | grep -oE '"failed":[0-9]+'    | head -1 | cut -d: -f2)
    done_flag=$(echo "$response" | grep -oE '"done":(true|false)' | head -1 | cut -d: -f2)
  fi

  # If the response doesn't look like our shape, dump it and stop — likely an
  # auth/server error that'll just keep repeating.
  if [ -z "${remaining:-}" ] || [ "$remaining" = "null" ]; then
    echo "[iter ${iteration}] unexpected response, stopping:"
    echo "$response"
    exit 1
  fi

  total_analyzed=$((total_analyzed + analyzed))
  total_failed=$((total_failed + failed))

  echo "[iter ${iteration}] processed=${processed} analyzed=${analyzed} failed=${failed} remaining=${remaining}"

  if [ "$done_flag" = "true" ] || [ "$remaining" = "0" ]; then
    echo
    echo "Done. Total: analyzed=${total_analyzed} failed=${total_failed} across ${iteration} iterations."
    break
  fi

  sleep "$PAUSE"
done
