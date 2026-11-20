#!/usr/bin/env bash
# The whole `deploy-check` sample contract for nginx and systemd (#882).
#
#   bash scripts/check-deploy-samples.sh
#
# Seventeen checks, and the summary says which kind each one is:
#
# 1. real: a real `nginx -t` parses deploy/nginx.conf.example;
# 2. real negative proof: the same invocation rejects a copy of the sample with a
#    deliberately unknown directive appended. A checker that accepts everything
#    fails here, so "the sample parsed" means something;
# 3. static: scripts/check-systemd-unit.mjs parses deploy/fledge.service;
# 4. static negative proof: the same parser rejects a copy with its ExecStart
#    removed;
# 5. static: the nginx check asserts the four security headers on the rendered
#    sample (#1009);
# 6. static negative proof for it: a copy missing one header, and a copy whose
#    HSTS line lost `always`, are both rejected and the header is named;
# 7. static negative proof for the location trap: a copy that declares a header
#    inside `location /` is rejected and the location is named, because nginx
#    stops inheriting the server set on that path (#1097);
# 8. control for it: a location that repeats all four headers with `always` is
#    still accepted, so the rule cannot pass by refusing every location;
# 9. static negative proof for the one-liner shape: `location = /health {
#    add_header ...; }` on one line is rejected and the location is named;
# 10. control for it: the same one-liner that repeats all four with `always` is
#    accepted, so the rule refuses the shadowing and not the shape;
# 11. static negative proof for the brace position: a location whose `{` sits on
#    the next line is still read and rejected;
# 12. static negative proof for a brace inside a token: a location whose regex
#    carries a `}` (`^/v}v[0-9]+`) is still read, and one header there is
#    rejected, because nginx keeps the brace in the token (#1097 review);
# 13. static negative proof for an inner level: an `if` inside a location that
#    declares one header is rejected and the inner block is named, because that
#    is the level which stops inheriting for the responses it applies to;
# 14. control for 12: a location whose regex carries a `}` at the end of a token
#    (`^/v}v[0-9]+$`) and that repeats the whole set is accepted, so a `}` in a
#    token is not refused. An unquoted regex quantifier is not this shape: nginx
#    treats `{` as a block opener even mid-token, so `^/v[0-9]{1,3}$` must be
#    quoted; the real `nginx -t` half is what rejects the unquoted form;
# 15. control for 12, second shape: a location whose regex quantifier is quoted
#    (`"^/v[0-9]{1,3}$"`) and that repeats the whole set is accepted, because a
#    `{` inside a quoted string is not a block opener. This is the shape a
#    self-hoster who writes a regex quantifier has to use;
# 16. control for 13: an `if` that repeats the whole set with `always` is
#    accepted, so the rule judges the level and not the block kind;
# 17. static negative proof for an empty input: an empty and a comment-only copy
#    are refused with "no server block to check", because a sample with no server
#    block used to pass with nothing asserted (#1097 test).
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

# 5/6. Security headers on the rendered sample (#1009). The trap is that a
# plain `add_header` is skipped on 4xx/5xx and a location that declares its own
# stops inheriting the server set, so the two negative copies below are what
# make the positive assertion mean something.
grep -v '^  add_header X-Frame-Options ' deploy/nginx.conf.example > "$work/no-frame-options.conf"
if output="$(bash scripts/check-nginx-config.sh --sample "$work/no-frame-options.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: ACCEPTED a copy without X-Frame-Options — the header check is not a gate (#1009)'
  exit 1
fi
if ! [[ "$output" == *'X-Frame-Options'* ]]; then
  printf '%s\n' "$output"
  echo 'security headers: the rejection of a copy without X-Frame-Options did not name the header (#1009)'
  exit 1
fi
echo 'security headers: negative proof — a copy missing X-Frame-Options was rejected'

sed 's/^\(  add_header Strict-Transport-Security .*\) always;$/\1;/' deploy/nginx.conf.example > "$work/no-always.conf"
if output="$(bash scripts/check-nginx-config.sh --sample "$work/no-always.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: ACCEPTED an HSTS line without `always` — nginx would drop it on its own 4xx/5xx (#1009)'
  exit 1
fi
if ! [[ "$output" == *'Strict-Transport-Security'* ]]; then
  printf '%s\n' "$output"
  echo 'security headers: the rejection of an HSTS line without `always` did not name the header (#1009)'
  exit 1
fi
echo 'security headers: negative proof — a copy whose HSTS lost `always` was rejected'

# 7/8. The trap the sample documents at deploy/nginx.conf.example:19-21 (#1097):
# a location that declares any `add_header` stops inheriting the server set, so
# the four headers disappear from every response that location serves. Neither
# negative copy above can see that — one deletes a server header, the other
# strips `always` — so this pair is what proves the gate reads deeper than the
# server level.
awk '
  { print }
  /^  location \/ \{/ && !inserted {
    print "    add_header Cache-Control \"no-store\" always;"
    inserted = 1
  }
' deploy/nginx.conf.example > "$work/location-header.conf"
if output="$(bash scripts/check-nginx-config.sh --sample "$work/location-header.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: ACCEPTED a location that declares its own add_header — nginx would drop all four headers there (#1097)'
  exit 1
fi
if ! [[ "$output" == *'location block opened at line'* ]]; then
  printf '%s\n' "$output"
  echo 'security headers: the rejection of a location-level header did not name the location block (#1097)'
  exit 1
fi
echo 'security headers: negative proof — a location that declares its own add_header was rejected'

# The control: the same location is legal once it repeats the whole set, so the
# rule above cannot be satisfied by refusing every location.
awk '
  { print }
  /^  location \/ \{/ && !inserted {
    print "    add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always;"
    print "    add_header X-Content-Type-Options \"nosniff\" always;"
    print "    add_header Referrer-Policy \"strict-origin-when-cross-origin\" always;"
    print "    add_header X-Frame-Options \"DENY\" always;"
    inserted = 1
  }
' deploy/nginx.conf.example > "$work/location-repeat.conf"
if ! output="$(bash scripts/check-nginx-config.sh --sample "$work/location-repeat.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: REJECTED a location that repeats all four headers with always — the location rule is not a gate (#1097)'
  exit 1
fi
echo 'security headers: control — a location that repeats all four headers with always was accepted'

# 9/10/11. The same trap in the shapes the first location rule could not read
# (#1097 review): a one-liner in which the `{`, the directive and the `}` share a
# line, a location whose `{` sits on the next line, and the one-liner that repeats
# the full set. A rule that only reads a header at the start of a line, or only a
# `{` on the location's own line, passes the first two and hides the risk.
awk '
  /^  location \/ \{/ && !inserted { print "  location = /health { add_header Cache-Control \"no-store\" always; }"; inserted = 1 }
  { print }
' deploy/nginx.conf.example > "$work/location-one-liner.conf"
if output="$(bash scripts/check-nginx-config.sh --sample "$work/location-one-liner.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: ACCEPTED a one-liner location that declares its own add_header — a shadowed header set would serve no security header (#1097)'
  exit 1
fi
if ! [[ "$output" == *'location block opened at line'* ]]; then
  printf '%s\n' "$output"
  echo 'security headers: the rejection of the one-liner location did not name the location block (#1097)'
  exit 1
fi
echo 'security headers: negative proof — a one-liner location that declares its own add_header was rejected'

awk '
  /^  location \/ \{/ && !inserted { print "  location = /health { add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always; add_header X-Content-Type-Options \"nosniff\" always; add_header Referrer-Policy \"strict-origin-when-cross-origin\" always; add_header X-Frame-Options \"DENY\" always; }"; inserted = 1 }
  { print }
' deploy/nginx.conf.example > "$work/location-one-liner-repeat.conf"
if ! output="$(bash scripts/check-nginx-config.sh --sample "$work/location-one-liner-repeat.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: REJECTED a one-liner location that repeats all four headers with always — the rule refuses the shape, not the shadowing (#1097)'
  exit 1
fi
echo 'security headers: control — a one-liner location that repeats all four headers with always was accepted'

awk '
  /^  location \/ \{/ && !inserted {
    print "  location /next"
    print "  {"
    print "    add_header Cache-Control \"no-store\" always;"
    print "  }"
    inserted = 1
  }
  { print }
' deploy/nginx.conf.example > "$work/location-brace-next-line.conf"
if output="$(bash scripts/check-nginx-config.sh --sample "$work/location-brace-next-line.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: ACCEPTED a location whose `{` is on the next line and declares its own add_header — the rule depends on where the brace sits (#1097)'
  exit 1
fi
if ! [[ "$output" == *'location block opened at line'* ]]; then
  printf '%s\n' "$output"
  echo 'security headers: the rejection of the brace-on-the-next-line location did not name the location block (#1097)'
  exit 1
fi
echo 'security headers: negative proof — a location whose `{` sits on the next line was rejected'

# 12/13. The two levels a brace-shape rule still missed (#1097 security review):
# a `}` that nginx keeps inside a regex token, and an `if` inside a location that
# declares its own header. Both are legal nginx and both serve fewer headers than
# the server set, so a rule that reads either as clean lets the shadowing back in.
awk '
  /^  location \/ \{/ && !inserted { print "  location ~ ^/v}v[0-9]+ { add_header Cache-Control \"no-store\" always; }"; inserted = 1 }
  { print }
' deploy/nginx.conf.example > "$work/location-brace-in-token.conf"
if output="$(bash scripts/check-nginx-config.sh --sample "$work/location-brace-in-token.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: ACCEPTED a location whose regex carries a `}` and that serves one header — nginx keeps the brace in the token and the block still opens (#1097)'
  exit 1
fi
if ! [[ "$output" == *'location block opened at line'* ]]; then
  printf '%s\n' "$output"
  echo 'security headers: the rejection of a brace-inside-a-token location did not name the location block (#1097)'
  exit 1
fi
echo 'security headers: negative proof — a location whose regex carries a `}` and serves one header was rejected'

awk '
  /^  location \/ \{/ && !inserted { print "  location /ifx { if ($request_method = POST) { add_header Cache-Control \"no-store\" always; } }"; inserted = 1 }
  { print }
' deploy/nginx.conf.example > "$work/location-if-header.conf"
if output="$(bash scripts/check-nginx-config.sh --sample "$work/location-if-header.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: ACCEPTED an if inside a location that declares one header — the matched responses serve only that header (#1097)'
  exit 1
fi
if ! [[ "$output" == *'inside a location'* ]]; then
  printf '%s\n' "$output"
  echo 'security headers: the rejection of an if-level header did not name the inner block (#1097)'
  exit 1
fi
echo 'security headers: negative proof — an if inside a location that declares one header was rejected'

awk '
  /^  location \/ \{/ && !inserted { print "  location ~ ^/v}v[0-9]+$ { add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always; add_header X-Content-Type-Options \"nosniff\" always; add_header Referrer-Policy \"strict-origin-when-cross-origin\" always; add_header X-Frame-Options \"DENY\" always; }"; inserted = 1 }
  { print }
' deploy/nginx.conf.example > "$work/location-brace-in-token-repeat.conf"
if ! output="$(bash scripts/check-nginx-config.sh --sample "$work/location-brace-in-token-repeat.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: REJECTED a valid regex location that repeats the whole set — a `}` inside a token is not a block boundary (#1097)'
  exit 1
fi
echo 'security headers: control — a `}` inside a location token with the whole set was accepted'

# The other tokenizer rule, from real nginx: a `{` is a block opener even
# mid-token, so a regex quantifier has to be quoted. The quoted form is legal and
# must stay accepted; the unquoted form is not this script's job to reject, the
# real `nginx -t` below the static half does that.
awk '
  /^  location \/ \{/ && !inserted { print "  location ~ \"^/v[0-9]{1,3}$\" { add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always; add_header X-Content-Type-Options \"nosniff\" always; add_header Referrer-Policy \"strict-origin-when-cross-origin\" always; add_header X-Frame-Options \"DENY\" always; }"; inserted = 1 }
  { print }
' deploy/nginx.conf.example > "$work/location-quoted-quantifier.conf"
if ! output="$(bash scripts/check-nginx-config.sh --sample "$work/location-quoted-quantifier.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: REJECTED a quoted regex quantifier that repeats the whole set — a `{` inside quotes is not a block opener (#1097)'
  exit 1
fi
echo 'security headers: control — a quoted regex quantifier with the whole set was accepted'

awk '
  /^  location \/ \{/ && !inserted { print "  location /ifx { if ($request_method = POST) { add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always; add_header X-Content-Type-Options \"nosniff\" always; add_header Referrer-Policy \"strict-origin-when-cross-origin\" always; add_header X-Frame-Options \"DENY\" always; } }"; inserted = 1 }
  { print }
' deploy/nginx.conf.example > "$work/location-if-repeat.conf"
if ! output="$(bash scripts/check-nginx-config.sh --sample "$work/location-if-repeat.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: REJECTED an if that repeats the whole set with always — the rule must judge the level, not the block kind (#1097)'
  exit 1
fi
echo 'security headers: control — an if that repeats the whole set with always was accepted'

# 17. The vacuous pass (#1097 test): with no `server` block the static half had
# nothing to assert, so an empty copy exited 0 "parsed". The gate has to refuse an
# input it cannot judge instead of passing it.
: > "$work/empty-nginx.conf"
if output="$(bash scripts/check-nginx-config.sh --sample "$work/empty-nginx.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: ACCEPTED an empty sample — a check with nothing to assert is not a gate (#1097)'
  exit 1
fi
if ! [[ "$output" == *'no server block to check'* ]]; then
  printf '%s\n' "$output"
  echo 'security headers: the rejection of an empty sample did not name the reason (#1097)'
  exit 1
fi
printf '# a sample with no server block\n' > "$work/comment-only-nginx.conf"
if output="$(bash scripts/check-nginx-config.sh --sample "$work/comment-only-nginx.conf" 2>&1)"; then
  printf '%s\n' "$output"
  echo 'security headers: ACCEPTED a comment-only sample — a vacuously green check is the bug (#1097)'
  exit 1
fi
echo 'security headers: negative proof — an empty and a comment-only sample were refused'

echo 'deploy-check: every sample check above is real or static; none is recorded as a gap.'
