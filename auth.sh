#!/bin/sh
# Mint a Cloudflare Access token for the AI Gateway proxy and launch opencode
# against it (see opencode.json in this directory).
set -eu

APP_URL="https://ai.example.com"

command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }

# Reuse the cached Access session when there is one; otherwise do the
# one-time browser login, then mint the token.
if ! TOKEN="$(cloudflared access token --app="$APP_URL" 2>/dev/null)"; then
	echo "No cached Access session - opening browser to log in..."
	cloudflared access login "$APP_URL"
	TOKEN="$(cloudflared access token --app="$APP_URL")"
fi

[ -n "$TOKEN" ] || { echo "failed to mint an Access token for $APP_URL" >&2; exit 1; }

echo "Access token minted for $APP_URL - launching opencode"
AIG_ACCESS_TOKEN="$TOKEN" exec opencode
