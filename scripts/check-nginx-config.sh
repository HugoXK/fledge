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
#
# #1009: before the parse, the rendered sample is also checked statically for the
# four console security headers in every top-level server block, each with
# `always`. test/securityHeaders.test.ts drives that half too, including the two
# negative proofs in scripts/check-deploy-samples.sh (a deleted header, and an
# HSTS line that lost `always`).
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

# #1009: the sample is what a self-hoster copies, so a missing security header
# has to fail here rather than in a browser. Every top-level `server` block must
# carry the four headers with `always`: two leading spaces is the sample's
# server level, and `always` is what keeps them on nginx's own 4xx/5xx (a 502
# while the app is down). This is static on purpose — a live 2xx probe passes
# today because the app itself already sends three of the four.
#
# #1097: the same rule at the level that can silently undo it. nginx does not
# merge header sets — a `location` that declares any `add_header` of its own
# stops inheriting the whole server set, so every response from that location
# (including the nginx-generated 4xx/5xx `always` exists for) would carry none of
# the four. The rule below reads a `location` body of any nesting depth: if it
# declares a header anywhere, it must repeat all four with `always` at its own
# level. The shipped sample declares none, so it stays as it is.
if ! header_errors="$(awk \
  -v names="Strict-Transport-Security X-Content-Type-Options Referrer-Policy X-Frame-Options" \
  -v label="$label" '
  function close_block() {
    for (i = 1; i <= n; i++) {
      if (!(want[i] in seen)) {
        bad++
        printf "nginx: %s security headers: server block opened at line %d has no `add_header %s ... always;`\n", label, start, want[i]
      }
    }
  }
  function close_location(   i) {
    if (loc_any[loc_top] == 1) {
      for (i = 1; i <= n; i++) {
        if (loc_seen[loc_top, want[i]] != 1) {
          bad++
          printf "nginx: %s security headers: location block opened at line %d declares its own `add_header`, which stops nginx inheriting the server-level set, so that block must repeat `add_header %s ... always;`\n", label, loc_start[loc_top], want[i]
        }
      }
    }
    loc_top--
  }
  BEGIN { n = split(names, want, " "); loc_top = 0 }
  /^server[ \t]*\{/ {
    if (open) {
      bad++
      printf "nginx: %s security headers: unterminated server block opened at line %d\n", label, start
    }
    open = 1
    depth = 1
    start = NR
    loc_top = 0
    split("", seen)
    next
  }
  open {
    line = $0
    if (line ~ /^[ \t]*location([ \t]|\{)/ && line ~ /\{/) {
      loc_top++
      loc_start[loc_top] = NR
      loc_depth[loc_top] = depth + 1
      loc_any[loc_top] = 0
      for (i = 1; i <= n; i++) delete loc_seen[loc_top, want[i]]
    }
    opens = gsub(/\{/, "{", line)
    closes = gsub(/\}/, "}", line)
    depth += opens - closes
    if (loc_top > 0 && $0 ~ /^[ \t]*add_header[ \t]/ && depth >= loc_depth[loc_top]) {
      loc_any[loc_top] = 1
      if (depth == loc_depth[loc_top]) {
        for (i = 1; i <= n; i++) {
          if ($0 ~ ("^[ \t]*add_header[ \t]+" want[i] "[ \t]") && $0 ~ /[ \t]always;[ \t]*$/) loc_seen[loc_top, want[i]] = 1
        }
      }
    }
    if (loc_top > 0 && depth < loc_depth[loc_top]) close_location()
    if (depth == 1) {
      for (i = 1; i <= n; i++) {
        if (index($0, "  add_header " want[i] " ") == 1 && $0 ~ /[ \t]always;[ \t]*$/) seen[want[i]] = 1
      }
    }
    if (depth <= 0) {
      close_block()
      open = 0
    }
  }
  END {
    while (loc_top > 0) close_location()
    if (open) close_block()
    exit bad > 0 ? 1 : 0
  }
' "$tmp/site.conf")"; then
  printf '%s\n' "$header_errors"
  exit 1
fi

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
