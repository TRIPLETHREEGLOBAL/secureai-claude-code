#!/usr/bin/env bash
# Route Claude Code in this terminal through SecureAI.
# The proxy URL carries Claude's own SecureAI credentials, so the gateway can
# accept the traffic and SecureAI can show "Claude is using the protected route".
# Claude Desktop manages its own connection and is not covered by this helper.

set -euo pipefail

resolve_url() {
  if [[ -n "${SECUREAI_PROXY_URL:-}" ]]; then
    printf '%s' "$SECUREAI_PROXY_URL"
    return
  fi
  local cli=""
  if command -v secureai >/dev/null 2>&1; then
    cli="secureai"
  elif [[ -n "${SECUREAI_HOME:-}" && -x "$SECUREAI_HOME/bin/secureai" ]]; then
    cli="$SECUREAI_HOME/bin/secureai"
  fi
  if [[ -n "$cli" ]]; then
    local line
    line="$("$cli" proxy-env --platform claude --shell posix 2>/dev/null | grep '^export HTTPS_PROXY=' | head -1 || true)"
    if [[ -n "$line" ]]; then
      printf '%s' "${line#export HTTPS_PROXY=}"
      return
    fi
  fi
  echo "SecureAI isn't installed or isn't running, so Claude Code was left unchanged." >&2
  return 1
}

URL="$(resolve_url)" || { [[ "${BASH_SOURCE[0]}" == "${0}" ]] && exit 1 || return 1; }
export HTTP_PROXY="$URL"
export HTTPS_PROXY="$URL"
export NO_PROXY="localhost,127.0.0.1,::1"
export SECUREAI_PROXY_URL="$URL"

echo "Claude Code in this terminal will now use SecureAI." >&2

# If sourced, exports stick; if executed, print exports for eval
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  printf 'export HTTP_PROXY=%q\n' "$URL"
  printf 'export HTTPS_PROXY=%q\n' "$URL"
  printf 'export NO_PROXY=%q\n' "localhost,127.0.0.1,::1"
  printf 'export SECUREAI_PROXY_URL=%q\n' "$URL"
fi
