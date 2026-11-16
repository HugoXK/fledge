#!/bin/sh
# Deploy the newest SemVer release tag when production is behind it.
#
# A release tag is the deploy unit. A main-only commit waits for the next tag;
# this script never rolls production back to an older tag and never pushes,
# bypasses the merge gate or merges. It builds from a detached tag worktree,
# stops/starts the host service, then runs `scripts/rollout-check.mjs` against
# the release it built (#658: the process, the page it renders and the bytes it
# serves must all be that tag), restores the previous dist when the rollout is
# refused, and then asks the verifier to write release-status.json.
#
# Environment (defaults are the current host layout):
#   FLEDGE_APP_DIR       /home/xuke/work/fledge
#   FLEDGE_SOURCE_DIR    /home/xuke/work/fledge-src
#   FLEDGE_DEPLOY_DIR    /home/xuke/work/fledge-deploy-src
#   FLEDGE_DEPLOY_LOG    /home/xuke/work/fledge-deploy-tag.log
#   FLEDGE_STOP_CMD      /home/xuke/work/fledge-stop.sh
#   FLEDGE_START_CMD     /home/xuke/work/fledge-start.sh
#   FLEDGE_HEALTH_URL    http://127.0.0.1:8095/healthz
#   FLEDGE_ROLLOUT_URL   the origin the rollout check reads (default: FLEDGE_HEALTH_URL without /healthz)
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

# #658: the rollout is gated on the release it claims, not on a version string.
# `/healthz` alone said `0.3.2` while the page and the served app.css came from
# another tree, so a stale process could be blessed as healthy. The check
# compares the process (version and commit), the page it renders (footer version
# and the ?v= token on app.css), the bytes it serves, and the running public/
# against the tag worktree — the artifact this deploy built from. A failure is a
# refused rollout: the previous dist and identity go back and the service is
# restarted on them.
"$STOP" >> "$LOG" 2>&1 || true
"$START" >> "$LOG" 2>&1 || true
ROLLOUT_URL=${FLEDGE_ROLLOUT_URL:-$(printf '%s' "$HEALTH" | sed 's#/healthz$##')}
ROLLOUT_OUT=/tmp/fledge-rollout-$$.txt
rollout() {
  if [ -f "$APP/.env" ]; then
    node --env-file="$APP/.env" "$APP/scripts/rollout-check.mjs" "$@"
  else
    node "$APP/scripts/rollout-check.mjs" "$@"
  fi
}
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if rollout --version "$TAG_VERSION" --commit "$TARGET" --base-url "$ROLLOUT_URL" \
    --release-dir "$DEPLOY" --public-dir "$APP/public" > "$ROLLOUT_OUT" 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
cat "$ROLLOUT_OUT" >> "$LOG" 2>/dev/null || true
rm -f "$ROLLOUT_OUT"
if [ "$ok" != "1" ]; then
  log "rollout refused for $TAG; rolling back dist"
  rm -rf "$APP/dist"
  mv "$APP/dist.bak-$ts" "$APP/dist" 2>/dev/null || true
  mv "$APP/.build-identity.bak" "$APP/.build-identity" 2>/dev/null || true
  "$START" >> "$LOG" 2>&1 || true
  exit 3
fi
log "healthy $TAG"
printf "%s %s\n" "$TAG" "$(date -u +%FT%TZ)" > "${FLEDGE_DATA_DIR:-/home/xuke/work/fledge-data}/deployed-tag"
VERIFY=${FLEDGE_VERIFY_SCRIPT:-$APP/deploy/fledge-verify-release.sh}
if [ -x "$VERIFY" ]; then
  # The chain snapshot is not the rollout gate — the gate above already answered.
  # A red verifier is logged by name here so it cannot disappear into `|| true`,
  # and it does not roll back a release that passed the gate.
  if "$VERIFY" >> "$LOG" 2>&1; then
    log "release-status: recorded for $TAG"
  else
    log "release-status: not released for $TAG; the rows above name the link"
  fi
fi
git worktree remove --force "$DEPLOY" >> "$LOG" 2>&1 || true
ls -1dt "$APP"/dist.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -rf
