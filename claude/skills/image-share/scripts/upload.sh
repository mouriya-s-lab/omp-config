#!/usr/bin/env bash
# Upload a local image to the operator's 0721 image host
# (img.237575.xyz) and print a public URL on stdout.
#
# Auth is auto-resolved:
#   1. $ZERO721_PASSWORD env var (highest priority, for explicit overrides)
#   2. $TF_VAR_zero721_admin_password from an already-loaded pve-vctcn env
#   3. pve-vctcn SOPS secrets file: _shared/secrets/secrets.yml
#
# Exit code is the source of truth for success/failure. On success exactly one
# line is written to stdout (the URL, or markdown form with -m). All diagnostics
# go to stderr.

set -euo pipefail

BASE_URL="${ZERO721_BASE_URL:-https://img.237575.xyz}"
EMAIL="${ZERO721_EMAIL:-mouriya@vctcn.local}"
IAC_REPO="${ZERO721_IAC_REPO:-/Users/mouriya/Ext/code/pve-vctcn}"
SECRETS_FILE="${ZERO721_SECRETS_FILE:-$IAC_REPO/_shared/secrets/secrets.yml}"

usage() {
  cat >&2 <<'USAGE'
Usage: upload.sh [-m|--markdown] <path-to-image>

Options:
  -m, --markdown   Output `![](URL)` instead of the bare URL.
  -h, --help       Show this help.

Environment overrides:
  ZERO721_BASE_URL     default: https://img.237575.xyz
  ZERO721_EMAIL        default: mouriya@vctcn.local
  ZERO721_PASSWORD     explicit password override
  ZERO721_IAC_REPO     default: /Users/mouriya/Ext/code/pve-vctcn
  ZERO721_SECRETS_FILE default: $ZERO721_IAC_REPO/_shared/secrets/secrets.yml

Default auth comes from pve-vctcn's SOPS+age secrets file. If the operator
already loaded the IaC env, TF_VAR_zero721_admin_password is used directly.

Stdout (success): https://img.237575.xyz/media/<key>
Exit codes: 0 ok, 1 runtime error, 2 usage error.
USAGE
}

die() { echo "ERROR: $*" >&2; exit 1; }

MARKDOWN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--markdown) MARKDOWN=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    --)            shift; break ;;
    -*)            usage; exit 2 ;;
    *)             break ;;
  esac
done
[[ $# -eq 1 ]] || { usage; exit 2; }

IMG_PATH=$1
[[ -f "$IMG_PATH" ]] || die "file not found: $IMG_PATH"
[[ -r "$IMG_PATH" ]] || die "file not readable: $IMG_PATH"

command -v curl >/dev/null || die "curl not in PATH"
command -v jq   >/dev/null || die "jq not in PATH"

read_sops_password() {
  [[ -f "$SECRETS_FILE" ]] || die "SOPS secrets file not found: $SECRETS_FILE"
  command -v sops >/dev/null || die "sops not in PATH; install it or set ZERO721_PASSWORD"
  command -v yq >/dev/null || die "yq not in PATH; install mikefarah yq or set ZERO721_PASSWORD"
  sops -d "$SECRETS_FILE" \
    | yq -er '.zero721_admin_password | select(type == "!!str" and length > 0)'
}

resolve_password() {
  if [[ -n "${ZERO721_PASSWORD:-}" ]]; then
    printf '%s' "$ZERO721_PASSWORD"
    return
  fi
  if [[ -n "${TF_VAR_zero721_admin_password:-}" ]]; then
    printf '%s' "$TF_VAR_zero721_admin_password"
    return
  fi
  read_sops_password
}

response_body_path() {
  local name=$1
  local dir="${XDG_CACHE_HOME:-$HOME/.cache}/image-share"
  mkdir -p "$dir"
  printf '%s/%s.%s.body' "$dir" "$name" "$$"
}

login() {
  local pw=$1
  local resp http body_file
  body_file=$(response_body_path 0721-login)
  resp=$(curl -sS -o "$body_file" -w '%{http_code}' \
    -X POST "$BASE_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    --data-raw "$(jq -nc --arg n "$EMAIL" --arg p "$pw" '{name:$n,password_raw:$p}')" \
    -m 15) || { rm -f "$body_file"; return 1; }
  http=$resp
  if [[ "$http" != 2?? ]]; then
    rm -f "$body_file"
    return 1
  fi
  local tok
  tok=$(jq -r .token < "$body_file" 2>/dev/null || true)
  rm -f "$body_file"
  [[ -n "$tok" && "$tok" != null ]] || return 1
  printf '%s' "$tok"
}

upload() {
  local token=$1 path=$2 name
  name=$(basename "$path")
  local resp http body_file
  body_file=$(response_body_path 0721-upload)
  resp=$(curl -sS -o "$body_file" -w '%{http_code}' \
    -X PUT "$BASE_URL/api/media/insert?name=$(printf %s "$name" | jq -sRr @uri)" \
    -H "Authorization: Bearer $token" \
    -F "file=@${path}" \
    -m 120) || { rm -f "$body_file"; return 1; }
  http=$resp
  if [[ "$http" != 2?? ]]; then
    local errbody
    errbody=$(cat "$body_file")
    rm -f "$body_file"
    if [[ "$errbody" == *"already uploaded"* ]]; then
      echo "0721 dedup-hit: this exact content was uploaded before." >&2
      echo "   reuse the existing URL, or modify the file (re-encode with imagemagick: \`magick in.png -strip out.png\`) before retry." >&2
    else
      echo "upload HTTP $http: $errbody" >&2
    fi
    return 1
  fi
  # Response is either a raw key string or JSON {"key":"..."} — handle both.
  local body key
  body=$(cat "$body_file")
  rm -f "$body_file"
  if key=$(printf '%s' "$body" | jq -er .key 2>/dev/null); then
    :
  else
    key=$(printf '%s' "$body" | tr -d '[:space:]"')
  fi
  [[ -n "$key" ]] || { echo "no key in response: $body" >&2; return 1; }
  printf '%s' "$key"
}

PW=$(resolve_password)
TOKEN=""
if ! TOKEN=$(login "$PW"); then
  die "login failed"
fi

KEY=$(upload "$TOKEN" "$IMG_PATH") || die "upload failed"
URL="$BASE_URL/media/$KEY"

if [[ $MARKDOWN -eq 1 ]]; then
  printf '![](%s)\n' "$URL"
else
  printf '%s\n' "$URL"
fi
