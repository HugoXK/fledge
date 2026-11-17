#!/usr/bin/env bash
# Syntax-check a nginx sample with a real nginx, inside the wrapper that
# deploy/nginx.check.conf renders (#795, #799).
#
#   bash scripts/check-nginx-config.sh [--sample PATH]
#
# One `nginx: ...` line goes to stdout for the job summary. Exit 0 only when
# nginx parsed the sample; exit 1 when nginx rejects it, when nginx is not
# installed, or when an argument is unknown — so `deploy-check`, and `ci-ok`,
# go red.
#
# #882: a runner without nginx used to print a "gap" and exit 0, which is how a
# broken sample merged behind a green gate. `deploy-check` installs nginx now,
# and a missing binary is a failure like any other. `--sample` exists so the
# negative proof in scripts/check-deploy-samples.sh can drive a deliberately
# broken copy through this same check: an invocation that cannot reject a broken
# sample is no evidence that the shipped one parses.
#
# The rendered wrapper and the rendered sample are ordinary files in a temporary
# directory, and they are the files `nginx -t` reads.
# test/nginxCheck.test.ts drives this script with a stub `nginx` and inspects
# that file, so an edit that drops the pid declaration fails the suite; the test
# does not read this script or the workflow text.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sample="$repo_root/deploy/nginx.conf.example"
wrapper="$repo_root/deploy/nginx.check.conf"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sample)
      if [ "$#" -lt 2 ]; then
        echo 'nginx: --sample needs a path' >&2
        exit 2
      fi
      sample="$2"
      shift 2
      ;;
    *)
      echo "nginx: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

label="${sample#"$repo_root"/}"

# #882: a failure, not a recordable gap. `deploy-check` installs nginx, so
# reaching this branch means the gate's input is missing, and a green job here
# would be a lie about the sample.
if ! command -v nginx >/dev/null 2>&1; then
  echo 'nginx: nginx is not installed — deploy-check must install it before this check runs (#882).'
  exit 1
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
    "$sample" > "$tmp/site.conf"

# Absolute paths, so the result does not depend on nginx's prefix, and a pid
# path this user can open (#795).
sed -e "s#__PID__#$tmp/nginx.pid#" -e "s#__SITE__#$tmp/site.conf#" "$wrapper" > "$tmp/nginx.conf"

# Capture the parse output and replay it on stdout: the workflow tees stdout to
# the job summary, so the reason a red run is red is in the log as well (#799).
if parse_output="$(nginx -t -q -c "$tmp/nginx.conf" -p "$tmp" 2>&1)"; then
  echo "nginx: $label parsed"
  exit 0
fi

echo "$parse_output"
echo "nginx: $label failed \`nginx -t\`"
exit 1
