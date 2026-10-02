#!/usr/bin/env bash
# Optional: bind ⌥. through skhd so the hotkey also launches Tenote when it
# isn't running. Safe to re-run; it never duplicates the binding.
set -euo pipefail
CTL="${TENOTECTL:-/Applications/Tenote Native.app/Contents/MacOS/tenotectl}"
[[ -x "$CTL" ]] || { echo "tenotectl not found at $CTL (set TENOTECTL=…)"; exit 1; }
if ! command -v skhd >/dev/null; then
  command -v brew >/dev/null || { echo "Install Homebrew (https://brew.sh) or skip this — Tenote's built-in ⌥. works without skhd."; exit 1; }
  brew install koekeishiya/formulae/skhd
fi
RC="$HOME/.skhdrc"
q() { [[ "$1" =~ [[:space:]] ]] && printf '"%s"' "$1" || printf '%s' "$1"; }
if grep -q tenotectl "$RC" 2>/dev/null; then
  echo "✓ keybinding already present"
else
  printf '\n# Tenote: Option+Period toggles the note card\nperiod - alt : %s toggle\n' "$(q "$CTL")" >> "$RC"
  echo "✓ added binding to $RC"
fi
skhd --start-service || brew services start skhd || true
echo "Now enable skhd in System Settings → Privacy & Security → Accessibility."
