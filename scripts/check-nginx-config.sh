#!/usr/bin/env bash
# Syntax-check deploy/nginx.conf.example with nginx, inside the wrapper that
# deploy/nginx.check.conf renders (#795).
#
# One `nginx: ...` line goes to stdout for the job summary. Exit 0 when the
# config parses, or when nginx is not installed on this runner and the summary
# records that as a gap; exit 1 when nginx rejects the config, so the
# `deploy-check` step - and `ci-ok` - go red.
#
# The rendered wrapper and the rendered example are ordinary files in a
# temporary directory, and they are the files `nginx -t` reads.
# test/nginxCheck.test.ts drives this script with a stub `nginx` and inspects
# that file, so an edit that drops the pid declaration fails the suite; the test
# does not read this script or the workflow text.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
example="$repo_root/deploy/nginx.conf.example"
wrapper="$repo_root/deploy/nginx.check.conf"

if ! command -v nginx >/dev/null 2>&1; then
  echo 'nginx: not installed on this runner — deploy/nginx.conf.example was not syntax-checked (gap).'
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The example names its certificates, logs and public listens; point them at
# this temporary directory and at loopback so the check needs no privileges.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" >/dev/null 2>&1

sed -e "s#/etc/letsencrypt/live/fledge.example.com/fullchain.pem#$tmp/cert.pem#" \
    -e "s#/etc/letsencrypt/live/fledge.example.com/privkey.pem#$tmp/key.pem#" \
    -e 's#/var/log/nginx/fledge-access.log#/dev/null#' \
    -e 's#/var/log/nginx/fledge-error.log#/dev/null#' \
    -e 's#listen 443 ssl http2;#listen 127.0.0.1:18443 ssl;#' \
    -e 's#listen 80;#listen 127.0.0.1:18080;#' \
    "$example" > "$tmp/site.conf"

# Absolute paths, so the result does not depend on nginx's prefix, and a pid
# path this user can open (#795).
sed -e "s#__PID__#$tmp/nginx.pid#" -e "s#__SITE__#$tmp/site.conf#" "$wrapper" > "$tmp/nginx.conf"

# Capture the parse output and replay it on stdout: the workflow tees stdout to
# the job summary, so the reason a red run is red is in the log as well (#799).
if parse_output="$(nginx -t -q -c "$tmp/nginx.conf" -p "$tmp" 2>&1)"; then
  echo 'nginx: deploy/nginx.conf.example parsed'
  exit 0
fi

echo "$parse_output"
echo 'nginx: deploy/nginx.conf.example failed `nginx -t`'
exit 1
