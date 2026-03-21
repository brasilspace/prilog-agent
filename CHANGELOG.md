# Changelog

## 2026-03-21

### Matrix Connector Installroutine
- Idempotente Installroutine fuer den `Prilog Matrix Connector` hinzugefuegt.
- Dieselbe Kernroutine wird jetzt fuer Neu-Provisionierung und Nachinstallation auf Bestandsservern verwendet.
- Provisionierung hat den neuen Schritt `install_matrix_connector` zwischen `generate_synapse` und `write_compose`.
- `homeserver.yaml` wird jetzt um den Synapse-Modulblock fuer den Connector erweitert oder davon bereinigt.
- `docker-compose.yml` mountet den Connector in den Synapse-Container und setzt `PYTHONPATH`, wenn der Connector fuer den Tenant aktiviert ist.
- Neuer Agent-Command `connector.install` fuehrt die gleiche Installroutine inkl. Compose-Refresh und Synapse-Restart aus.
