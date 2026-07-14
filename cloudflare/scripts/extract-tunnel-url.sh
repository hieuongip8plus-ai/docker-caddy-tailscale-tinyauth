#!/usr/bin/env bash
# Cloudflare: print the quick-tunnel URL (*.trycloudflare.com) from cloudflared logs.
# Exit 0 and print URL on stdout when found; exit 1 if not found within timeout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TIMEOUT="${1:-${TEST_TIMEOUT:-120}}"
INTERVAL="${2:-5}"

deadline=$((SECONDS + TIMEOUT))
while (( SECONDS < deadline )); do
  # Prefer running container; still works if restarting (logs retained)
  logs="$(docker compose logs --no-color --no-log-prefix cloudflared 2>&1 || true)"

  # Common log lines:
  #   https://xxxx.trycloudflare.com
  #   |  https://xxxx.trycloudflare.com
  #   Your quick Tunnel has been created! Visit it at ...
  candidate="$(printf '%s\n' "$logs" | grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | head -1 || true)"
  if [[ -n "$candidate" ]]; then
    echo "$candidate"
    exit 0
  fi

  # Fail fast if named-tunnel mode is still active without a token
  if printf '%s\n' "$logs" | grep -Eqi 'TUNNEL_TOKEN|must specify|failed to create|error parsing tunnel|provided tunnel token'; then
    if ! printf '%s\n' "$logs" | grep -Eqi 'trycloudflare|Requesting new quick Tunnel'; then
      echo "ERROR: cloudflared does not look like quick-tunnel mode (still named/token?)" >&2
      printf '%s\n' "$logs" | tail -n 40 >&2
      exit 1
    fi
  fi

  sleep "$INTERVAL"
done

echo "ERROR: no trycloudflare.com URL found in cloudflared logs within ${TIMEOUT}s" >&2
echo "--- last cloudflared logs ---" >&2
docker compose logs --no-color --tail=80 cloudflared >&2 || true
echo "--- resolved command ---" >&2
docker compose config 2>/dev/null | sed -n '/^  cloudflared:/,/^  [a-z]/p' | head -60 >&2 || true
exit 1
