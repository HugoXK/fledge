#!/bin/sh
# Write the release-chain snapshot the admin page renders.
#
#   deploy/fledge-verify-release.sh
#
# The GitHub token comes from GITHUB_TOKEN, or from the first `GITHUB_TOKEN`
# entry in FLEDGE_SECRETS_FILE (default ~/.dsh/bot/secrets.json). It is read into
# the environment and never printed or passed as an argument. METRICS_TOKEN and
# BASE_URL come from the app `.env` through node --env-file. The status is
# written to a temporary file and renamed, so the admin page never reads a
# half-written JSON document.
#
# Cron is expected to keep this quiet: a verification that reports
# `release-status: not released` is still a normal result, not a crash. Missing
# input (no token, no package/app) exits 1.
set -eu

APP=${FLEDGE_APP_DIR:-/home/xuke/work/fledge}
DATA=${FLEDGE_DATA_DIR:-/home/xuke/work/fledge-data}
SECRETS=${FLEDGE_SECRETS_FILE:-$HOME/.dsh/bot/secrets.json}
REPO=${FLEDGE_REPOSITORY:-HugoXK/fledge}
LOCK=/tmp/fledge-verify-release.lock
STATUS="$DATA/release-status.json"
TMP="$DATA/.release-status.$$.json"

exec 9>"$LOCK"
if ! flock -n 9; then exit 0; fi
if [ ! -f "$APP/package.json" ] || [ ! -f "$APP/.env" ]; then exit 1; fi

TOKEN=${GITHUB_TOKEN:-}
if [ -z "$TOKEN" ] && [ -f "$SECRETS" ]; then
  TOKEN=$(FLEDGE_SECRETS_FILE="$SECRETS" node -e '
    const fs = require("node:fs")
    const parsed = JSON.parse(fs.readFileSync(process.env.FLEDGE_SECRETS_FILE, "utf8"))
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.secrets) ? parsed.secrets : [])
    const entry = list.find((item) => item && item.name === "GITHUB_TOKEN")
    if (entry && typeof entry.value === "string") process.stdout.write(entry.value)
  ')
fi
if [ -z "$TOKEN" ]; then
  echo "[$(date -u +%FT%TZ)] verify-release: no GitHub token; skipped" >&2
  exit 1
fi

VERSION=$(node -p "require(\"$APP/package.json\").version")
BASE_URL=$(node --env-file="$APP/.env" -p "process.env.BASE_URL || \"https://fledge.hugoxk.online\"")
mkdir -p "$DATA"
set +e
GITHUB_TOKEN="$TOKEN" GITHUB_REPOSITORY="$REPO" node --env-file="$APP/.env" "$APP/scripts/verify-release.mjs" \
  --version "$VERSION" --base-url "$BASE_URL" --write "$TMP"
CODE=$?
set -e
if [ -f "$TMP" ]; then mv "$TMP" "$STATUS"; else rm -f "$TMP"; fi
exit "$CODE"
