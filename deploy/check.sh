#!/usr/bin/env bash
# check.sh - outside-in health and security check of the running site.
#
# Run it from your LAPTOP (Git Bash), not on the server:
#
#   bash deploy/check.sh                       # the production address
#   bash deploy/check.sh my-host.example.com   # another host
#
# Checks: /api/health answers, /api/overview is refused (401) without a login, the
# security headers and HSTS are present, the TLS certificate is valid and, when
# nmap is installed, only ports 80 and 443 are open. Changes nothing, sends no secrets.
set -euo pipefail

HOST="${1:-investments.daniel-henke.de}"
BASE="https://${HOST}"
FAILED=0

pass() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; FAILED=1; }

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }

# TLS: curl without -k fails on an invalid, expired or mismatched certificate.
if curl -fsS -o /dev/null --max-time 15 "${BASE}/api/health" 2>/dev/null; then
  pass "TLS certificate is valid and /api/health answers 200"
else
  bad "could not fetch ${BASE}/api/health with a valid certificate"
fi

health="$(curl -sS --max-time 15 "${BASE}/api/health" 2>/dev/null || true)"
case "$health" in
  *'"status":"ok"'* | *'"status": "ok"'*) pass "health reports status ok" ;;
  *) bad "health body does not report status ok" ;;
esac

code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/overview" 2>/dev/null || echo 000)"
if [ "$code" = "401" ]; then
  pass "/api/overview is refused without a session (401)"
else
  bad "/api/overview returned $code without a session, expected 401"
fi

headers="$(curl -sSI --max-time 15 "${BASE}/api/health" 2>/dev/null | tr -d '\r' || true)"
has_header() { printf '%s\n' "$headers" | grep -iq "^$1:"; }
for h in Strict-Transport-Security X-Content-Type-Options X-Frame-Options \
  Referrer-Policy Content-Security-Policy X-Robots-Tag; do
  if has_header "$h"; then pass "header $h present"; else bad "header $h missing"; fi
done
if printf '%s\n' "$headers" | grep -i '^Strict-Transport-Security:' | grep -Eq 'max-age=[0-9]{7,}'; then
  pass "HSTS max-age is at least a year-ish (7+ digits)"
else
  bad "HSTS max-age missing or too short"
fi
if printf '%s\n' "$headers" | grep -iq '^Server:'; then
  bad "Server header is exposed"
else
  pass "no Server header"
fi

# HTTP must redirect to HTTPS.
rcode="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "http://${HOST}/" 2>/dev/null || echo 000)"
case "$rcode" in
  301 | 302 | 307 | 308) pass "plain http redirects to https ($rcode)" ;;
  *) bad "plain http returned $rcode, expected a redirect" ;;
esac

# Open ports (only when nmap is installed).
if command -v nmap >/dev/null 2>&1; then
  open="$(nmap -Pn --top-ports 1000 --open "$HOST" 2>/dev/null | awk '/^[0-9]+\/tcp[[:space:]]+open/ {split($1,a,"/"); print a[1]}' | sort -n | tr '\n' ' ')"
  if [ "$(echo "$open" | xargs)" = "80 443" ]; then
    pass "only ports 80 and 443 are open"
  else
    bad "open ports: ${open:-none} (expected only 80 443)"
  fi
else
  echo "SKIP  nmap not installed; port check skipped"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "All checks passed."
else
  echo "Some checks FAILED." >&2
  exit 1
fi
