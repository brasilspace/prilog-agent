#!/bin/bash
# Prilog Agent — Installations-Script
# Wird vom cloud-init Script aufgerufen.
# Konfiguration liegt bereits in /etc/prilog/agent.env

set -e

INSTALL_DIR="/opt/prilog-agent"
SERVICE_FILE="/etc/systemd/system/prilog-agent.service"
ENV_SOURCE="/etc/prilog/agent.env"

echo "[prilog-agent] Installiere..."

# ── Node.js installieren (falls nicht vorhanden) ──────────────────────────────
if ! command -v node &> /dev/null; then
  echo "[prilog-agent] Installiere Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "[prilog-agent] Node $(node -v), npm $(npm -v)"

# ── Repository klonen ─────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[prilog-agent] Update vorhandene Installation..."
  cd "$INSTALL_DIR" && git pull
else
  echo "[prilog-agent] Klone Repository..."
  git clone https://github.com/brasilspace/prilog-agent.git "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ── Dependencies & Build ──────────────────────────────────────────────────────
echo "[prilog-agent] Installiere Dependencies..."
npm install

echo "[prilog-agent] Build..."
npm run build

echo "[prilog-agent] DevDependencies entfernen..."
npm prune --omit=dev


# ── .env aus /etc/prilog/agent.env verlinken ──────────────────────────────────
if [ -f "$ENV_SOURCE" ]; then
  cp "$ENV_SOURCE" "$INSTALL_DIR/.env"
  # Backend-URL Variablen ergänzen falls nicht gesetzt
  grep -q "BACKEND_WS_URL" "$INSTALL_DIR/.env" || echo "BACKEND_WS_URL=wss://api.prilog.chat/agent/ws" >> "$INSTALL_DIR/.env"
  grep -q "SYNAPSE_ADMIN_URL" "$INSTALL_DIR/.env" || echo "SYNAPSE_ADMIN_URL=http://localhost:8008" >> "$INSTALL_DIR/.env"
  grep -q "METRICS_INTERVAL" "$INSTALL_DIR/.env" || echo "METRICS_INTERVAL=30000" >> "$INSTALL_DIR/.env"
  grep -q "HEARTBEAT_INTERVAL" "$INSTALL_DIR/.env" || echo "HEARTBEAT_INTERVAL=15000" >> "$INSTALL_DIR/.env"
  grep -q "LOG_LEVEL" "$INSTALL_DIR/.env" || echo "LOG_LEVEL=info" >> "$INSTALL_DIR/.env"
  echo "[prilog-agent] Konfiguration übernommen aus $ENV_SOURCE"
else
  echo "[prilog-agent] WARNUNG: $ENV_SOURCE nicht gefunden!"
  exit 1
fi

# ── Systemd Service installieren ──────────────────────────────────────────────
cp "$INSTALL_DIR/prilog-agent.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable prilog-agent
systemctl start prilog-agent

echo "[prilog-agent] ✅ Installation abgeschlossen"
echo "[prilog-agent] Status: $(systemctl is-active prilog-agent)"
