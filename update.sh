#!/bin/bash
# Prilog Agent — Update-Script
# Zieht den neuesten Code, baut neu, restartet den Agent.
# Kann jederzeit manuell auf dem Kundenserver ausgeführt werden.
#
# Verwendung:
#   bash /opt/prilog-agent/update.sh
#   bash /opt/prilog-agent/update.sh --reprovision   (Agent updaten + Provision neu starten)

set -e

INSTALL_DIR="/opt/prilog-agent"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[prilog]${NC} $1"; }
warn() { echo -e "${YELLOW}[prilog]${NC} $1"; }
fail() { echo -e "${RED}[prilog]${NC} $1"; exit 1; }

# ── Prüfungen ───────────────────────────────────────────────────────────────
[ -d "$INSTALL_DIR/.git" ] || fail "Agent nicht installiert unter $INSTALL_DIR"
command -v node &> /dev/null || fail "Node.js nicht gefunden"

cd "$INSTALL_DIR"

# ── Aktuellen Status zeigen ─────────────────────────────────────────────────
BEFORE=$(git rev-parse --short HEAD)
log "Aktueller Stand: $BEFORE"

# ── Pull ────────────────────────────────────────────────────────────────────
log "Ziehe neuesten Code..."
git pull --ff-only || fail "Git pull fehlgeschlagen — manuelle Auflösung nötig"

AFTER=$(git rev-parse --short HEAD)
if [ "$BEFORE" = "$AFTER" ]; then
    log "Bereits auf dem neuesten Stand ($AFTER)"
else
    log "Aktualisiert: $BEFORE → $AFTER"
fi

# ── Dependencies & Build ────────────────────────────────────────────────────
log "Installiere Dependencies..."
npm install --silent 2>/dev/null

log "Baue Agent..."
npm run build

log "Entferne DevDependencies..."
npm prune --omit=dev --silent 2>/dev/null

# ── Restart ─────────────────────────────────────────────────────────────────
log "Starte Agent neu..."
systemctl restart prilog-agent
sleep 2

if systemctl is-active --quiet prilog-agent; then
    log "Agent läuft ✓"
else
    fail "Agent konnte nicht gestartet werden — prüfe: journalctl -u prilog-agent -n 30"
fi

# ── Optional: Re-Provision ──────────────────────────────────────────────────
if [ "$1" = "--reprovision" ]; then
    warn "Re-Provision angefordert — Agent verbindet sich und wartet auf Backend-Befehl."
    warn "Provision muss im Admin-Panel getriggert werden."
fi

# ── Status ──────────────────────────────────────────────────────────────────
log "Fertig. Agent-Version: $(git rev-parse --short HEAD)"
log "Logs: journalctl -u prilog-agent -f"
