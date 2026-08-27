#!/usr/bin/env bash
# Holt die gebuendelten Synapse-Module aus ihren Repos in assets/.
#
# Die Tenant-in-a-Box setzt Boxen ohne Netz auf — deshalb liegen die
# Modul-Quellen im Agent-Paket. Diese Kopien driften, wenn sie niemand
# nachzieht, und eine gedriftete Zugriffsregel ist schlimmer als keine.
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANAGED_ROOMS_SRC="${MANAGED_ROOMS_SRC:-$HOME/synapse-managed-rooms}"
CONNECTOR_SRC="${CONNECTOR_SRC:-$HOME/prilog-matrix-connector}"

if [ ! -d "$MANAGED_ROOMS_SRC/synapse_managed_rooms" ]; then
  echo "Modul-Repo nicht gefunden: $MANAGED_ROOMS_SRC" >&2
  echo "Pfad ueber MANAGED_ROOMS_SRC setzen." >&2
  exit 1
fi

DEST="$AGENT_DIR/assets/synapse-managed-rooms"
HERKUNFT="$DEST/HERKUNFT.md"
TMP_HERKUNFT="$(mktemp)"
[ -f "$HERKUNFT" ] && cp "$HERKUNFT" "$TMP_HERKUNFT"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -a "$MANAGED_ROOMS_SRC/synapse_managed_rooms" "$DEST/"
cp "$MANAGED_ROOMS_SRC/pyproject.toml" "$MANAGED_ROOMS_SRC/README.md" "$MANAGED_ROOMS_SRC/LICENSE" "$DEST/"
find "$DEST" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
[ -s "$TMP_HERKUNFT" ] && mv "$TMP_HERKUNFT" "$HERKUNFT"

VERSION="$(grep -oP '(?<=^__version__ = ")[^"]+' "$DEST/synapse_managed_rooms/__init__.py")"
echo "synapse-managed-rooms $VERSION nach assets/ uebernommen"

# ── prilog-matrix-connector ─────────────────────────────────────────────────
# Am 2026-08-27 war dieses Asset 48 Zeilen gedriftet und e2ee_guard.py fehlte
# ganz — neue Boxen haetten einen Connector ohne E2EE-Waechter bekommen, und
# auf einem Shared-Host lag ein handgepatchtes module.py. Genau dagegen ist
# dieses Skript da.
if [ -d "$CONNECTOR_SRC/src/prilog_matrix_connector" ]; then
  CDEST="$AGENT_DIR/assets/prilog-matrix-connector"
  rm -rf "$CDEST/src"
  mkdir -p "$CDEST/src"
  cp -a "$CONNECTOR_SRC/src/prilog_matrix_connector" "$CDEST/src/"
  cp "$CONNECTOR_SRC/pyproject.toml" "$CONNECTOR_SRC/README.md" "$CDEST/"
  find "$CDEST" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
  echo "prilog-matrix-connector nach assets/ uebernommen"
else
  echo "WARNUNG: Connector-Repo nicht unter $CONNECTOR_SRC — Asset bleibt wie es ist." >&2
fi

echo "Nicht vergessen: git add assets/ && committen."
