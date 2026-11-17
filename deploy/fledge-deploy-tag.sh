#!/bin/sh
# Deploy the newest SemVer release tag when production is behind it.
#
# A release tag is the deploy unit. A main-only commit waits for the next tag;
# this script never rolls production back to an older tag and never pushes,
# bypasses the merge gate or merges. It builds from a detached tag worktree,
# stops/starts the host service, then runs `scripts/rollout-check.mjs` against
# the release it built (#658: the process, the page it renders and the bytes it
# serves must all be that tag), restores the previous release — dist, public/,
# package.json and build identity — when a build or the rollout is refused, and
# then asks the verifier to write release-status.json.
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
DIST_BAK="$APP/dist.bak-$ts"
PUBLIC_BAK="$APP/public.bak-$ts"
MANIFEST_BAK="$APP/package.json.bak-$ts"
IDENTITY_BAK="$APP/.build-identity.bak-$ts"

# The release a host runs is four things, not one: `dist` is the build, `public/`
# is what the process serves, `package.json` carries the version it reports at
# startup (`VERSION` in src/version.ts), and `.build-identity` is the commit
# `/healthz` answers. The source copy below replaces all of them, so all of them
# are snapshotted here and restored together on any failure. Restoring `dist`
# alone would restart the old build under the new release's name, and would leave
# the version check at the top of this script reading the target version and
# exiting 0 as "at or ahead", so the tag would never be deployed or gated again.
snapshot_release() {
  cp -a "$APP/dist" "$DIST_BAK" 2>/dev/null || true
  cp -a "$APP/public" "$PUBLIC_BAK" 2>/dev/null || true
  cp -p "$APP/package.json" "$MANIFEST_BAK" 2>/dev/null || true
  cp -p "$APP/.build-identity" "$IDENTITY_BAK" 2>/dev/null || true
}

restore_release() {
  if [ -d "$DIST_BAK" ]; then
    rm -rf "$APP/dist"
    mv "$DIST_BAK" "$APP/dist" || log "could not restore dist from $DIST_BAK"
  fi
  if [ -d "$PUBLIC_BAK" ]; then
    rm -rf "$APP/public"
    mv "$PUBLIC_BAK" "$APP/public" || log "could not restore public/ from $PUBLIC_BAK"
  fi
  if [ -f "$MANIFEST_BAK" ]; then
    cp -p "$MANIFEST_BAK" "$APP/package.json" || log "could not restore package.json from $MANIFEST_BAK"
  fi
  if [ -f "$IDENTITY_BAK" ]; then
    cp -p "$IDENTITY_BAK" "$APP/.build-identity" || log "could not restore .build-identity from $IDENTITY_BAK"
  fi
}

snapshot_release
if ! rsync -a --ignore-times --delete --exclude .git --exclude .env --exclude node_modules --exclude dist \
  --exclude backups --exclude data --exclude "*.db" --exclude "*.db-wal" --exclude "*.db-shm" \
  --exclude "*.log" --exclude "dist.bak*" --exclude "public.bak*" --exclude "package.json.bak*" \
  --exclude ".build-identity.bak*" "$DEPLOY/" "$APP/" >> "$LOG" 2>&1; then
  log "source copy failed; restoring the release it replaced"
  restore_release
  exit 3
fi
if ! (cd "$APP" && npm ci --registry=https://registry.npmjs.org --no-audit --no-fund && npm run build) >> "$LOG" 2>&1; then
  log "build failed; restoring the release it replaced"
  restore_release
  exit 3
fi
printf "GIT_SHA=%s\nBUILD_TIME=%s\n" "$TARGET" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$APP/.build-identity"
chmod 644 "$APP/.build-identity"
# A predictable report path in a world-writable directory is a file another
# account can point somewhere else before the check writes it.
if ! ROLLOUT_OUT=$(mktemp "${TMPDIR:-/tmp}/fledge-rollout-XXXXXX"); then
  log "no temporary path for the rollout report; restoring the release it replaced"
  restore_release
  exit 3
fi

# #658: the rollout is gated on the release it claims, not on a version string.
# `/healthz` alone said `0.3.2` while the page and the served app.css came from
# another tree, so a stale process could be blessed as healthy. The check
# compares the process (version and commit), the page it renders (footer version
# and the ?v= token on app.css), the bytes it serves, and the running public/
# against the tag worktree — the artifact this deploy built from. A failure is a
# refused rollout: the previous release goes back and the service is restarted on
# it, so the tag is retried on the next tick instead of being recorded deployed.
"$STOP" >> "$LOG" 2>&1 || true
"$START" >> "$LOG" 2>&1 || true
ROLLOUT_URL=${FLEDGE_ROLLOUT_URL:-$(printf '%s' "$HEALTH" | sed 's#/healthz$##')}
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
  log "rollout refused for $TAG; restoring the release it replaced"
  restore_release
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
for family in dist public; do
  ls -1dt "$APP/$family".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -rf
done
ls -1dt "$APP"/package.json.bak-* "$APP"/.build-identity.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
