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
#
# #1097 security review: two shapes still walked past it, both legal nginx. A `}`
# that nginx keeps inside a token (`location ~ ^/v}v[0-9]+`) does not close the
# block, and an `if` inside a location is a header-owning level of its own: when
# it declares any `add_header`, the responses it applies to drop the enclosing
# set. The reader therefore closes a block only on a `}` at a token boundary,
# opens one on every `{` outside a quoted string and outside the `${var}` form
# (`nginx -t` rejects an unquoted regex quantifier), refuses a brace that closes
# or opens nothing, and judges every block that declares a header — not just the
# innermost `location`. `include` stays unread here; the real `nginx -t` below is
# what covers a header set that arrives through one.
if ! header_errors="$(awk \
  -v names="Strict-Transport-Security X-Content-Type-Options Referrer-Policy X-Frame-Options" \
  -v label="$label" '
  function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
  function push_block(header, at_line,   i, kind) {
    depth++
    kind = "other"
    # #1097 review: the block is recognised from its header text, not from where
    # its `{` sits, so `location x\n{` and a one-liner read the same.
    if (header ~ /^server([ \t]|$)/) { kind = "server"; servers++ }
    else if (header ~ /^location[ \t]/) kind = "location"
    kind_at[depth] = kind
    line_at[depth] = at_line
    any_at[depth] = 0
    for (i = 1; i <= n; i++) delete seen_at[depth, want[i]]
  }
  function close_block(   i, kind, parent) {
    if (depth <= 0) return
    kind = kind_at[depth]
    parent = (depth > 1) ? kind_at[depth - 1] : "other"
    if (kind == "server") {
      for (i = 1; i <= n; i++) {
        if (seen_at[depth, want[i]] != 1) {
          bad++
          printf "nginx: %s security headers: server block opened at line %d has no `add_header %s ... always;`\n", label, line_at[depth], want[i]
        }
      }
    } else if (any_at[depth] == 1) {
      # #1097 audit: the level that stops inheritance is not always a `location`.
      # An `if` (or `limit_except`) inside a server or a location that declares
      # any `add_header` drops the enclosing set for exactly the responses it
      # applies to, so that level is judged on what it serves.
      for (i = 1; i <= n; i++) {
        if (seen_at[depth, want[i]] != 1) {
          bad++
          if (kind == "location") {
            printf "nginx: %s security headers: location block opened at line %d declares its own `add_header`, which stops nginx inheriting the server-level set, so that block must repeat `add_header %s ... always;`\n", label, line_at[depth], want[i]
          } else {
            printf "nginx: %s security headers: block opened at line %d inside a %s declares its own `add_header`, which stops nginx inheriting the enclosing set for the responses it applies to, so that block must repeat `add_header %s ... always;`\n", label, line_at[depth], parent, want[i]
          }
        }
      }
    }
    depth--
  }
  function directive(text,   i) {
    if (depth == 0 || text !~ /^add_header[ \t]/) return
    any_at[depth] = 1
    if (text !~ /[ \t]always$/) return
    for (i = 1; i <= n; i++) {
      if (text ~ ("^add_header[ \t]+" want[i] "[ \t]")) seen_at[depth, want[i]] = 1
    }
  }
  BEGIN { n = split(names, want, " "); depth = 0; bad = 0; servers = 0; buf = ""; quote = ""; esc = 0; sq = sprintf("%c", 39) }
  {
    line = $0
    # #1097 review: a CRLF copy used to fail with "has no add_header" although
    # every header was there; the `\r` sat between the value and `always`.
    gsub(/\r/, "", line)
    for (c = 1; c <= length(line); c++) {
      ch = substr(line, c, 1)
      if (quote != "") {
        buf = buf ch
        if (esc) { esc = 0; continue }
        if (ch == "\\") { esc = 1; continue }
        if (ch == quote) quote = ""
        continue
      }
      if (ch == "#") break
      if (ch == "\"" || ch == sq) { quote = ch; buf = buf ch; continue }
      # #1097 review: a directive is read as a token stream, so `{`, `}` and `;`
      # may share a line with the header and the body.
      #
      # #1097 audit: nginx keeps a `}` inside a token, so `^/v}v[0-9]+` is one
      # token and the block still opens at the `{`. A `}` closes a block only at
      # a token boundary; anywhere else it stays in the token, and the block is
      # still classified from its header text. A `}` arriving at a boundary with
      # no block open is refused rather than dropped, because this half must fail
      # closed.
      #
      # #1097 audit, real nginx 1.18: a `{` is a block opener wherever it appears
      # outside a quoted string, even mid-token — nginx reports
      # `unknown directive "1,3}$"` for an unquoted `^/v[0-9]{1,3}$`, so a regex
      # quantifier has to be quoted. The one exception is the `${var}` form,
      # where the `{` directly after `$` belongs to the token. A `{` with nothing
      # before it opens nothing, so it is refused too.
      at_boundary = (buf == "" || buf ~ /[ \t]$/)
      if (ch == "{") {
        if (buf ~ /\$$/) { buf = buf ch }
        else if (trim(buf) == "") {
          bad++
          printf "nginx: %s: unexpected open brace at line %d\n", label, NR
        } else {
          push_block(trim(buf), NR)
          buf = ""
        }
        continue
      }
      if (ch == "}") {
        if (!at_boundary) { buf = buf ch; continue }
        if (depth == 0) {
          bad++
          printf "nginx: %s: unexpected close brace at line %d\n", label, NR
        } else {
          close_block()
        }
        buf = ""
        continue
      }
      if (ch == ";") { directive(trim(buf)); buf = ""; continue }
      buf = buf ch
    }
    if (quote != "") { quote = ""; esc = 0 }
    buf = buf " "
  }
  END {
    while (depth > 0) close_block()
    # #1097 test: an empty or comment-only sample has nothing to assert, so the
    # half used to pass vacuously. A sample with no server block is a refusal.
    if (servers == 0) {
      bad++
      printf "nginx: %s security headers: no server block to check — a sample that has none cannot carry the four headers\n", label
    }
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
