# Changelog

## 2026-03-21

### Synapse Port-Bindung fuer Runtime-Zugriff
- Der Agent veroeffentlicht Synapse jetzt standardmaessig nicht mehr nur auf `127.0.0.1:8008`, sondern konfigurierbar ueber `synapseBindAddress`.
- Ohne explizite Vorgabe wird `8008` auf allen Interfaces publiziert, damit `api.prilog.chat` und Tailscale-/Runtime-Zugriffe den Homeserver erreichen koennen.

### Connector-Artefakt Download
- Der Agent kann den `Prilog Matrix Connector` jetzt auch als Tarball von der Prilog-Infrastruktur laden und entpacken.
- Wenn `packageUrl` vorhanden ist, wird zuerst dieser Weg genutzt; Git bleibt nur noch Fallback.

### Connector Repo via SSH
- Der Agent zieht den `Prilog Matrix Connector` jetzt standardmaessig ueber `git@github.com:brasilspace/prilog-matrix-connector.git`.
- Fehlt auf dem Kundenserver ein GitHub-Deploy-Key oder SSH-Zugang, liefert der Agent jetzt eine klare SSH-bezogene Fehlermeldung statt des anonymen HTTPS-Clone-Fehlers.

### Matrix Connector Installroutine
- Idempotente Installroutine fuer den `Prilog Matrix Connector` hinzugefuegt.
- Dieselbe Kernroutine wird jetzt fuer Neu-Provisionierung und Nachinstallation auf Bestandsservern verwendet.
- Provisionierung hat den neuen Schritt `install_matrix_connector` zwischen `generate_synapse` und `write_compose`.
- `homeserver.yaml` wird jetzt um den Synapse-Modulblock fuer den Connector erweitert oder davon bereinigt.
- `docker-compose.yml` mountet den Connector in den Synapse-Container und setzt `PYTHONPATH`, wenn der Connector fuer den Tenant aktiviert ist.
- Neuer Agent-Command `connector.install` fuehrt die gleiche Installroutine inkl. Compose-Refresh und Synapse-Restart aus.
