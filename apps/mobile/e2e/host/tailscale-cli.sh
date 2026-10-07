# shellcheck shell=bash
# Sourced by run-host.sh and serve.sh. Sets TS to the Tailscale CLI: $TAILSCALE
# if given, else `tailscale` on PATH, else the macOS app bundle, which is also
# the CLI (it is not on PATH on Sean's Mac).
tailscale_cli() {
  local candidate
  for candidate in "${TAILSCALE:-}" "$(command -v tailscale 2>/dev/null || true)" \
    /Applications/Tailscale.app/Contents/MacOS/Tailscale "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      TS=$candidate
      # The app bundle's executable is the GUI too; ask for CLI mode explicitly.
      [[ "$TS" == */Tailscale.app/Contents/MacOS/Tailscale ]] && export TAILSCALE_BE_CLI=1
      "$TS" version >/dev/null 2>&1 && return 0
    fi
  done
  echo "Tailscale CLI not found; set TAILSCALE=/path/to/tailscale" >&2
  return 1
}
tailscale_cli
