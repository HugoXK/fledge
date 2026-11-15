#!/bin/sh
# Deploy the newest SemVer release tag when production is behind it.
#
# A release tag is the deploy unit. A main-only commit waits for the next tag;
# this script never rolls production back to an older tag and never pushes,
# bypasses the merge gate or merges. It builds from a detached tag worktree,
# stops/starts the host service, checks `/healthz`, restores the previous dist
# on failure, and then asks the verifier to write release-status.json.
#
# Environment (defaults are the current host layout):
#   FLEDGE_APP_DIR       /home/xuke/work/fledge
#   FLEDGE_SOURCE_DIR    /home/xuke/work/fledge-src
#   FLEDGE_DEPLOY_DIR    /home/xuke/work/fledge-deploy-src
#   FLEDGE_DEPLOY_LOG    /home/xuke/work/fledge-deploy-tag.log
#   FLEDGE_STOP_CMD      /home/xuke/work/fledge-stop.sh
#   FLEDGE_START_CMD     /home/xuke/work/fledge-start.sh
#   FLEDGE_HEALTH_URL    http://127.0.0.1:8095/healthz
set -eu

APP=${FLEDGE_APP_DIR:-/home/xuke/work/fledge}
SRC=${FLEDGE_SOURCE_DIR:-/home/xuke/work/fledge-src}
DEPLOY=${FLEDGE_DEPLOY_DIR:-/home/xuke/work/fledge-deploy-src}
LOG=${FLEDGE_DEPLOY_LOG:-/home/xuke/work/fledge-deploy-tag.log}
STOP=${FLEDGE_STOP_CMD:-/home/xuke/work/fledge-stop.sh}
START=${FLEDGE_START_CMD:-/home/xuke/work/fledge-start.sh}
HEALTH=${FLEDGE_HEALTH_URL:-http://127.0.0.1:8095/healthz}
LOCK=/tmp/fledge-deploy-tag.lock

exec 9>"$LOCK"
if ! flock -n 9; then exit 0; fi
log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }

cd "$SRC"
git fetch --tags origin main >> "$LOG" 2>&1 || { log "fetch failed"; exit 2; }

TAG=$(git tag --list "v[0-9]*.[0-9]*.[0-9]*" --sort=-v:refname | head -n 1)
[ -n "$TAG" ] || { log "no release tag"; exit 0; }
TARGET=$(git rev-list -n 1 "$TAG")
CURRENT=$(sed -n "s/^GIT_SHA=//p" "$APP/.build-identity" 2>/dev/null | head -n 1)
[ -n "$CURRENT" ] || { log "no build identity; refusing"; exit 2; }
if [ "$CURRENT" = "$TARGET" ]; then log "already at $TAG"; exit 0; fi

# Production may run a server-deploy merge commit that is not on main, so
# ancestry is not a usable forward test. The release version is: deploy only a
# tag newer than the running package version. Same or older waits, which is
# what prevents a rollback of a later main.
CURRENT_VERSION=$(node -p "require(\"$APP/package.json\").version" 2>/dev/null || true)
TAG_VERSION=${TAG#v}
[ -n "$CURRENT_VERSION" ] || { log "no running package version; refusing"; exit 2; }
LATEST=$(printf "%s\n%s\n" "$CURRENT_VERSION" "$TAG_VERSION" | sort -V | tail -n 1)
if [ "$LATEST" = "$CURRENT_VERSION" ]; then
  log "running v$CURRENT_VERSION is at or ahead of $TAG; waiting for a newer tag"
  exit 0
fi
log "deploying $TAG ($TARGET), currently v$CURRENT_VERSION at $CURRENT"

if [ -d "$DEPLOY/.git" ] || git worktree list | grep -q "$DEPLOY"; then
  git worktree remove --force "$DEPLOY" >> "$LOG" 2>&1 || rm -rf "$DEPLOY"
fi
git worktree prune
git worktree add --detach "$DEPLOY" "$TAG" >> "$LOG" 2>&1 || { log "worktree failed"; exit 3; }

ts=$(date +%Y%m%d-%H%M%S)
cp -a "$APP/dist" "$APP/dist.bak-$ts" 2>/dev/null || true
cp -p "$APP/.build-identity" "$APP/.build-identity.bak" 2>/dev/null || true
if ! rsync -a --delete --exclude .git --exclude .env --exclude node_modules --exclude dist \
  --exclude backups --exclude data --exclude "*.db" --exclude "*.db-wal" --exclude "*.db-shm" \
  --exclude "*.log" --exclude "dist.bak-*" "$DEPLOY/" "$APP/" >> "$LOG" 2>&1; then
  log "source copy failed"
  exit 3
fi
if ! (cd "$APP" && npm ci --registry=https://registry.npmjs.org --no-audit --no-fund && npm run build) >> "$LOG" 2>&1; then
  log "build failed; restoring dist"
  rm -rf "$APP/dist"
  mv "$APP/dist.bak-$ts" "$APP/dist" 2>/dev/null || true
  mv "$APP/.build-identity.bak" "$APP/.build-identity" 2>/dev/null || true
  exit 3
fi
printf "GIT_SHA=%s\nBUILD_TIME=%s\n" "$TARGET" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$APP/.build-identity"
chmod 644 "$APP/.build-identity"

"$STOP" >> "$LOG" 2>&1 || true
"$START" >> "$LOG" 2>&1 || true
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 "$HEALTH" | grep -q "\"version\":\"${TAG_VERSION}\""; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != "1" ]; then
  log "health failed for $TAG; rolling back dist"
  rm -rf "$APP/dist"
  mv "$APP/dist.bak-$ts" "$APP/dist" 2>/dev/null || true
  mv "$APP/.build-identity.bak" "$APP/.build-identity" 2>/dev/null || true
  "$START" >> "$LOG" 2>&1 || true
  exit 3
fi
log "healthy $TAG"
printf "%s %s\n" "$TAG" "$(date -u +%FT%TZ)" > "${FLEDGE_DATA_DIR:-/home/xuke/work/fledge-data}/deployed-tag"
VERIFY=${FLEDGE_VERIFY_SCRIPT:-$APP/deploy/fledge-verify-release.sh}
[ -x "$VERIFY" ] && "$VERIFY" >> "$LOG" 2>&1 || true
git worktree remove --force "$DEPLOY" >> "$LOG" 2>&1 || true
ls -1dt "$APP"/dist.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -rf
