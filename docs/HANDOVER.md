# Handover

## Stand 2026-03-21

Der Agent hat jetzt eine idempotente Installroutine fuer den `Prilog Matrix Connector`.

## Was umgesetzt ist

- `ProvisionConfig` kennt jetzt `synapseModules.connector`.
- Neue gemeinsame Helper:
  - `src/provision/compose.ts`
  - `src/provision/connector.ts`
- Neuer Provision-Step:
  - `install_matrix_connector`
- Der Connector wird bei aktiver Modul-Konfiguration
  - aus Git ausgecheckt bzw. aktualisiert,
  - in `homeserver.yaml` eingetragen,
  - im Compose-File in den Synapse-Container gemountet.
- Neuer Agent-Command:
  - `connector.install`
- Wenn `packageUrl` in der Connector-Konfiguration vorhanden ist, laedt der Agent jetzt ein Tarball-Artefakt von der Prilog-Infrastruktur und entpackt es lokal.
- Der Connector-Checkout nutzt jetzt standardmaessig den privaten SSH-Repo-Pfad `git@github.com:brasilspace/prilog-matrix-connector.git`.
- Kundenserver brauchen dafuer einen GitHub-Deploy-Key oder SSH-Zugang fuer root bzw. den laufenden Agent-Prozess.

## Wichtige Pfade auf dem Zielserver

- Connector Checkout:
  - `/opt/synapse/connectors/prilog-matrix-connector`
- Synapse Config:
  - `/mnt/prilog-data/synapse/homeserver.yaml`
- Compose:
  - `/opt/prilog/docker-compose.yml`

## Build-Status

- `npm install`
- `npm run build`

beides erfolgreich.

## Test nach Deploy

1. Provisionierung eines neuen Servers bis `install_matrix_connector`.
2. Pruefen, ob auf dem Zielserver:
   - der Connector-Checkout existiert
   - `homeserver.yaml` den Modulblock enthaelt
   - `docker-compose.yml` den Connector mountet
3. `connector.install` gegen einen bestehenden Server ausloesen und pruefen, ob Synapse danach mit geladenem Modul startet.
4. Wenn Artefakt-Auslieferung aktiv ist:
   - pruefen, ob `packageUrl` verwendet wird
   - und kein GitHub-Zugang auf dem Kundenserver noetig ist

## Update 2026-03-21 - Synapse Runtime-Port

- `docker-compose.yml` publiziert Synapse nicht mehr hart nur auf `127.0.0.1:8008`.
- Neue Provision-Configs koennen `synapseBindAddress` setzen; ohne Vorgabe wird `8008` auf allen Interfaces veroeffentlicht.
- Das ist wichtig fuer den zentralen Zugriff von `api.prilog.chat` auf Kundenserver ueber Hostname/Tailscale.
