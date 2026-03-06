# prilog-agent

Remote management & monitoring agent für Prilog Matrix Synapse Server.

## Architektur

```
Kunden-Server                    Prilog Backend
┌─────────────────────┐          ┌──────────────────────┐
│  prilog-agent       │          │  api.prilog.chat      │
│                     │  WSS     │                       │
│  ┌───────────────┐  │◄────────►│  /agent/ws            │
│  │  Transport    │  │          │                       │
│  │  (WebSocket)  │  │          │  agentRegistry        │
│  └───────────────┘  │          │  Map<orderId, conn>   │
│         │           │          └──────────┬────────────┘
│  ┌──────▼────────┐  │                     │
│  │  Agent        │  │          ┌──────────▼────────────┐
│  │  Orchestrator │  │          │  Admin Frontend        │
│  └──────┬────────┘  │          │  - Live Metrics        │
│         │           │          │  - Log Streaming       │
│  ┌──────▼────────┐  │          │  - Remote Commands     │
│  │  Handlers     │  │          │  - Module Management   │
│  │  - metrics    │  │          └───────────────────────┘
│  │  - modules    │  │
│  │  - shell      │  │
│  └───────────────┘  │
└─────────────────────┘
```

## Features

- **Persistente WebSocket-Verbindung** — bidirektional, real-time
- **Auto-Reconnect** — exponential backoff (2s → 60s)
- **Metriken** — CPU, RAM, Disk, Volume, Matrix-Usercount (alle 30s)
- **Log-Streaming** — Synapse, Nginx, Agent-Logs live
- **Module-Management** — Docker Compose Module aktivieren/deaktivieren
- **Remote-Commands** — Whitelist-basiert, kein arbitrary shell exec
- **Self-Update** — `agent.update` Command
- **Systemd-Service** — startet automatisch nach Reboot

## Installation (automatisch via cloud-init)

```bash
# Ins Verzeichnis
mkdir -p /opt/prilog-agent
cd /opt/prilog-agent
git clone https://github.com/brasilspace/prilog-agent.git .

# Dependencies
npm install && npm run build

# .env befüllen
cp .env.example .env
# AGENT_TOKEN, SUBDOMAIN, MATRIX_DOMAIN setzen

# Systemd
cp prilog-agent.service /etc/systemd/system/
systemctl enable prilog-agent
systemctl start prilog-agent
```

## Commands (von Admin sendbar)

| Command | Beschreibung |
|---|---|
| `synapse.restart` | Synapse Container neu starten |
| `synapse.reload` | Synapse Config neu laden (HUP) |
| `synapse.status` | Docker Status |
| `docker.ps` | Alle laufenden Container |
| `docker.logs` | Container-Logs abrufen |
| `module.enable` | Modul aktivieren |
| `module.disable` | Modul deaktivieren |
| `module.status` | Modul-Übersicht |
| `logs.stream.start` | Live Log-Stream starten |
| `logs.stream.stop` | Log-Stream stoppen |
| `system.status` | Uptime, RAM, Disk |
| `system.df` | Volume-Auslastung |
| `agent.update` | Agent selbst updaten |
| `agent.version` | Agent-Version abfragen |

## Sicherheit

- Alle Commands sind whitelisted — kein arbitrary shell exec
- Modulnamen werden gegen `/^[a-z0-9_-]+$/` validiert
- TLS-verschlüsselt (WSS)
- Token pro Server — kein geteilter Secret
