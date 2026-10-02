#!/bin/sh
# Writes web/config.js from the container's environment, so one image serves every
# deployment. Run by the nginx image's own entrypoint (/docker-entrypoint.d/*.sh) before
# nginx starts.
#
#   DENT_WEB_OIDC_AUTHORITY   https URL of an OpenID Connect issuer (e.g. a Keycloak realm)
#   DENT_WEB_OIDC_CLIENT_ID   the public client registered there
#   DENT_WEB_EDGE_LIMIT_MB    request-body cap of a CDN in front of the app, in MB
#
# All unset is valid: the app runs without accounts (the self-hosted default). Every value
# is checked against a strict pattern and the container REFUSES TO START on a bad one,
# because these are interpolated into JavaScript and the image has no JSON encoder.
set -eu

OUT=/usr/share/nginx/html/config.js
A="${DENT_WEB_OIDC_AUTHORITY:-}"
C="${DENT_WEB_OIDC_CLIENT_ID:-}"
L="${DENT_WEB_EDGE_LIMIT_MB:-}"

die() { echo "40-dentistry-config: $*" >&2; exit 1; }

if [ -n "$A" ] || [ -n "$C" ]; then
  [ -n "$A" ] && [ -n "$C" ] || die "set both DENT_WEB_OIDC_AUTHORITY and DENT_WEB_OIDC_CLIENT_ID, or neither"
  printf '%s' "$A" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$' \
    || die "DENT_WEB_OIDC_AUTHORITY is not a plain http(s) URL: $A"
  printf '%s' "$C" | grep -Eq '^[A-Za-z0-9._-]{1,64}$' \
    || die "DENT_WEB_OIDC_CLIENT_ID may contain only letters, digits, '.', '_' and '-'"
  OIDC="{ authority: '$A', client_id: '$C' }"
else
  OIDC=null
fi

if [ -n "$L" ]; then
  printf '%s' "$L" | grep -Eq '^[0-9]{1,6}$' || die "DENT_WEB_EDGE_LIMIT_MB must be a whole number"
  LIMIT="$L"
else
  LIMIT=null
fi

cat > "$OUT" <<JS
// Written at container start by 40-dentistry-config.sh. Do not edit in the image.
window.DENTISTRY_CONFIG = { oidc: $OIDC, edgeBodyLimitMB: $LIMIT };
JS
echo "40-dentistry-config: accounts $( [ "$OIDC" = null ] && echo off || echo "on ($A)" ), edge limit ${LIMIT}"
