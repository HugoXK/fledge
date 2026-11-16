#!/usr/bin/env bash
# The whole `deploy-check` sample contract for nginx and systemd (#882).
#
#   bash scripts/check-deploy-samples.sh
#
# Four checks, and the summary says which kind each one is:
#
# 1. real: a real `nginx -t` parses deploy/nginx.conf.example;
# 2. real negative proof: the same invocation rejects a copy of the sample with a
#    deliberately unknown directive appended. A checker that accepts everything
#    fails here, so "the sample parsed" means something;
# 3. static: scripts/check-systemd-unit.mjs parses deploy/fledge.service;
# 4. static negative proof: the same parser rejects a copy with its ExecStart
#    removed.
#
# Exit 1 on the first check that does not hold. No branch of this script records a
# gap and exits 0: `deploy-check` installs nginx, and the parser is plain node.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1. A real parse of the shipped sample.
if output="$(bash scripts/check-nginx-config.sh 2>&1)"; then
  printf '%s\n' "$output"
  version="$(nginx -v 2>&1 || true)"
  echo "nginx: real parse of deploy/nginx.conf.example passed (${version:-nginx version unknown})"
else
  printf '%s\n' "$output"
  echo 'nginx: FAILED the real parse of deploy/nginx.conf.example — deploy-check is red'
  exit 1
fi

# 2. Negative proof: the same check, on a copy that cannot parse. The marker is a
# directive nginx does not know, so the rejection comes from the parser rather
# than from a missing certificate or port.
cp deploy/nginx.conf.example "$work/broken-nginx.conf"
printf '\nbogus_882_self_check on;\n' >> "$work/broken-nginx.conf"
if output="$(bash scripts/check-nginx-config.sh --sample "$work/broken-nginx.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'nginx: ACCEPTED a deliberately broken sample — the parse is not real (#882)'
  exit 1
fi
echo 'nginx: negative proof — a deliberately broken sample was rejected'

# 3. The systemd unit, statically.
if output="$(node scripts/check-systemd-unit.mjs deploy/fledge.service 2>&1)"; then
  printf '%s\n' "$output"
  echo 'systemd: static unit parser chosen over systemd-analyze verify (absent on runners; it also reports unrelated runner units)'
else
  printf '%s\n' "$output"
  echo 'systemd: FAILED the static unit parse of deploy/fledge.service — deploy-check is red'
  exit 1
fi

# 4. Negative proof for the parser: a service with no ExecStart cannot start, so
# a parser that accepts one is not a gate.
grep -v '^ExecStart=' deploy/fledge.service > "$work/broken-fledge.service"
if node scripts/check-systemd-unit.mjs "$work/broken-fledge.service" >/dev/null 2>&1; then
  echo 'systemd: ACCEPTED a unit with no ExecStart — the parser is not a gate (#882)'
  exit 1
fi
echo 'systemd: negative proof — a unit with no ExecStart was rejected'

echo 'deploy-check: every sample check above is real or static; none is recorded as a gap.'
