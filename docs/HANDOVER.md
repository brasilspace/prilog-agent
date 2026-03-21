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
