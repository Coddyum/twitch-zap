#!/usr/bin/env bash
# Installe Twitch Zap : extension chargee par Brave + daemon Hyprland.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$ROOT/extension"
FLAGS="${XDG_CONFIG_HOME:-$HOME/.config}/brave-origin-flags.conf"
UNIT_DIR="$HOME/.config/systemd/user"
NODE="$(command -v node || true)"

say() { printf '\033[35m==>\033[0m %s\n' "$1"; }

# ---------------------------------------------------------------- daemon
if [[ -z "$NODE" ]]; then
  echo "node introuvable dans le PATH, daemon non installe." >&2
else
  say "Installation du daemon systemd (--user)"
  mkdir -p "$UNIT_DIR"
  sed -e "s|@NODE@|$NODE|" -e "s|@DAEMON@|$ROOT/daemon/twitch-zap-daemon.mjs|" \
    "$ROOT/daemon/twitch-zap.service" > "$UNIT_DIR/twitch-zap.service"
  systemctl --user daemon-reload
  systemctl --user enable --now twitch-zap.service
  systemctl --user --no-pager --lines=0 status twitch-zap.service | head -3 || true
fi

# ------------------------------------------------------------- extension
say "Enregistrement de l'extension dans $FLAGS"
touch "$FLAGS"
cp "$FLAGS" "$FLAGS.bak.$(date +%Y%m%d%H%M%S)"

if grep -q -- "$EXT" "$FLAGS"; then
  echo "    deja presente."
elif grep -q -- '^--load-extension=' "$FLAGS"; then
  sed -i "s|^--load-extension=.*|&,$EXT|" "$FLAGS"
  echo "    ajoutee a la liste --load-extension existante."
else
  echo "--load-extension=$EXT" >> "$FLAGS"
  echo "    nouvelle ligne --load-extension ajoutee."
fi

say "Termine."
cat <<'TXT'

Il reste a :
  1. Redemarrer Brave completement (toutes les fenetres) pour charger l'extension.
  2. Verifier / regler les raccourcis dans  brave://extensions/shortcuts
       Ctrl+Shift+Space  ouvrir Twitch Zap
       Ctrl+Shift+M      basculer solo <-> ecrans
       Ctrl+Shift+U      oublier les exceptions et remuter tout
     (mettre la portee sur "Global" si tu veux les declencher hors focus Brave)
TXT
