# Woher diese Dateien kommen

Kopie aus dem Repo **`synapse-managed-rooms`** (Apache-2.0). Sie liegt hier,
weil die Tenant-in-a-Box eine Box ohne Netz und ohne Git-Zugang aufsetzen
koennen muss — genau wie beim `prilog-matrix-connector` daneben.

**Nicht hier bearbeiten.** Aenderungen gehoeren ins Modul-Repo, danach:

```bash
bash scripts/sync-module-assets.sh
```

Warum das wichtig ist: Ein `modules:`-Eintrag in `homeserver.yaml` ohne
passende Quellen im Mount startet Synapse im Crash-Loop (rssw-Incident
2026-05-18). Was hier liegt, muss zu dem passen, was der Backend-Manifest
schreibt.
