#!/usr/bin/env bash
# Re-analyzes all conversations tagged with a given issue label whose last
# analysis predates a cutoff. Drives /api/admin/reanalyze-by-issue in a loop
# until the remaining count hits 0. Each call processes up to LIMIT
# conversations (default 10) at ~15s spacing to fit gpt-4o's 30k TPM cap.
#
# Required env var:
#   CRON_SECRET — production secret (Vercel → Settings → Environment Variables)
# Optional env vars (with defaults):
#   APP_URL       = https://ai-chat-qa-tool.vercel.app
#   ISSUE         = "Slow response times"
#   CUTOFF        = 2026-04-30T13:30:00Z   (gpt-4o switchover; conversations
#                                            analyzed before this ran on gpt-5-mini)
#   ANALYZED_FROM = (unset)                (optional ISO floor on analyzed_at —
#                                            use to scope to "rows analyzed since X",
#                                            e.g. after a prompt edit today)
#   LIMIT         = 10                     (max 16; sized for the 300s timeout)
#   PAUSE         = 3                      (seconds between iterations)
#
# Usage:
#   export CRON_SECRET=<paste from Vercel>
#   ./scripts/reanalyze-by-issue.sh
#
# Stop anytime with Ctrl-C — the next cron tick won't re-process anything
# already updated.

set -euo pipefail

if [ -z "${CRON_SECRET:-}" ]; then
  echo "CRON_SECRET env var is required. Set it with: export CRON_SECRET=..." >&2
  exit 1
fi

APP_URL="${APP_URL:-https://ai-chat-qa-tool.vercel.app}"
ISSUE="${ISSUE:-Slow response times}"
CUTOFF="${CUTOFF:-2026-04-30T13:30:00Z}"
FROM_DATE="${FROM_DATE:-2026-04-27T00:00:00Z}"
ANALYZED_FROM="${ANALYZED_FROM:-}"
LIMIT="${LIMIT:-10}"
PAUSE="${PAUSE:-3}"

# URL-encode spaces in the issue label so the query string is valid.
ISSUE_ENCODED="${ISSUE// /%20}"

ENDPOINT="${APP_URL}/api/admin/reanalyze-by-issue?issue=${ISSUE_ENCODED}&cutoff=${CUTOFF}&fromDate=${FROM_DATE}&limit=${LIMIT}"
if [ -n "$ANALYZED_FROM" ]; then
  ENDPOINT="${ENDPOINT}&analyzedFrom=${ANALYZED_FROM}"
fi

echo "Reanalyzing conversations tagged: \"${ISSUE}\""
echo "  fromDate:     ${FROM_DATE}  (intercom_created_at floor)"
echo "  cutoff:       ${CUTOFF}  (re-runs analyses before this)"
if [ -n "$ANALYZED_FROM" ]; then
  echo "  analyzedFrom: ${ANALYZED_FROM}  (analyzed_at floor)"
fi
echo "  limit:        ${LIMIT} per call"
echo "  pause:        ${PAUSE}s between calls"
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
