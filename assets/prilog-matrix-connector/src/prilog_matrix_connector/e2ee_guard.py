"""
e2ee_guard.py — server-seitiger Encryption-/Marker-Guard fuer den Vertraulichen
Chat (E2EE-Umsetzungsplan v0.3, AP-3.4; Mechanismus bestaetigt in AP-0.5).

WAS DER GUARD TUT (und nur das):
Er schliesst das "falsche Siegel" — die gefaehrlichste Fehlklasse (ein Raum
sieht vertraulich aus, ist aber NICHT verschluesselt) — und die irreversible
Footgun (Encryption in einen Werkzeug-Raum gesetzt → DMS/Suche/Policy sterben
still). Beides ist rein aus Raum-State entscheidbar, OHNE Backend-Call:

  1. `m.room.encryption` ist NUR im Raumtyp "Vertraulicher Chat" erlaubt.
  2. Der Vertraulich-Marker ist nur in einem so getypten Raum gueltig.
  3. Bei Erstellung eines Vertraulichen Chats werden Encryption + Marker
     AUTORITATIV gesetzt (Erstellung ist die Wahrheit).

Die "nur Mitarbeiter"-Mitglieder-Invariante bedient weiterhin der bestehende
`membership-guardian` (Backend, v0.3 Kap. 3) — nicht dieses Modul.

FLEXIBILITAETS-LEITPLANKE (Owner, v0.3 AP-0.5): Matrix-Interna leben HIER an
einer Stelle und spiegeln die Backend-Wahrheit in `backend-api/src/config/
e2ee.ts` — beide muessen synchron bleiben. Bricht ein Synapse-Update den
preventiven Weg, faellt das System auf die Detektiv-Kontrolle (Cron) zurueck,
nicht auf "nichts". Vor jedem Synapse-Upgrade das 3-Punkt-Experiment (v0.3
AP-0.5) gegen die neue Version fahren.

STATUS: default-INERT. Der Guard wird nur registriert, wenn
`e2ee_guard_enabled: true` in der Modul-Config steht. Der destruktive
Bestaetigungstest (lehnt Synapse die drei Verletzungen wirklich preventiv ab?)
gehoert auf ein WEGWERF-Synapse (Owner-Entscheid B) — bis dahin bleibt der
Flag ueberall aus.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger(__name__)


def _as_mapping(value: Any) -> Mapping | None:
    """
    Synapse-Event-Content ist ein `frozendict`/`immutabledict` — KEIN `dict`-
    Subtyp. `isinstance(x, dict)` scheitert daher auf echten Events (im Unit-
    Test mit Plain-Dicts unsichtbar; vom Wegwerf-Synapse-Test 2026-07-16
    aufgedeckt). Deshalb ueberall gegen `collections.abc.Mapping` pruefen.
    """
    return value if isinstance(value, Mapping) else None

# --- Matrix-Interna: EINE Stelle (Spiegel von backend-api/src/config/e2ee.ts) ---
CONFIDENTIAL_ROOM_TYPE = "prilog.confidential"
MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2"
CONFIDENTIAL_MARKER_EVENT = "chat.prilog.confidential"

_CREATE_EVENT = "m.room.create"
_ENCRYPTION_EVENT = "m.room.encryption"


# --- Reine Logik (unit-testbar ohne Synapse) ------------------------------


def is_confidential_create_content(create_content: Any) -> bool:
    """True, wenn der m.room.create-Content den Vertraulich-Raumtyp traegt."""
    m = _as_mapping(create_content)
    if m is None:
        return False
    return m.get("type") == CONFIDENTIAL_ROOM_TYPE


def evaluate_event(
    event_type: str,
    event_content: dict[str, Any] | None,
    create_content: dict[str, Any] | None,
) -> bool:
    """
    Kern-Entscheidung. Gibt True (erlauben) / False (ablehnen) zurueck.

    - `m.room.encryption`: nur in einem Vertraulich-Raum UND nur mit Megolm.
      → verhindert Encryption im Werkzeug-Raum (Footgun) und ein falsches
        Verschluesselungs-Verfahren.
    - Vertraulich-Marker: nur in einem Vertraulich-getypten Raum gueltig.
      → verhindert das "falsche Siegel" per nachtraeglich injiziertem Marker.
    - alles andere: unberuehrt erlauben (schneller Durchlass).
    """
    confidential = is_confidential_create_content(create_content)

    if event_type == _ENCRYPTION_EVENT:
        if not confidential:
            return False
        ec = _as_mapping(event_content)
        algo = ec.get("algorithm") if ec is not None else None
        return algo == MEGOLM_ALGORITHM

    if event_type == CONFIDENTIAL_MARKER_EVENT:
        return confidential

    return True


def build_confidential_initial_state() -> list[dict[str, Any]]:
    """
    Autoritatives initial_state fuer einen neu erstellten Vertraulichen Chat:
    Encryption (Megolm) + Marker. So kann kein Raum als vertraulich gelten und
    zugleich Klartext sein (Erstellung = Wahrheit).
    """
    return [
        {
            "type": _ENCRYPTION_EVENT,
            "state_key": "",
            "content": {"algorithm": MEGOLM_ALGORITHM},
        },
        {
            "type": CONFIDENTIAL_MARKER_EVENT,
            "state_key": "",
            "content": {"confidential": True},
        },
    ]


def apply_confidential_creation(request_content: dict[str, Any]) -> bool:
    """
    Wenn `request_content` einen Vertraulichen Chat anlegt (`creation_content.type`
    ODER top-level `type` == Vertraulich-Raumtyp), Encryption + Marker ins
    initial_state injizieren (idempotent). Gibt True zurueck, wenn injiziert
    wurde. Mutiert `request_content` in place — Synapse verwendet den Dict nach
    dem on_create_room-Callback weiter.
    """
    if not isinstance(request_content, dict):
        return False

    creation_content = request_content.get("creation_content")
    top_type = request_content.get("type")
    cc_type = creation_content.get("type") if isinstance(creation_content, dict) else None
    if top_type != CONFIDENTIAL_ROOM_TYPE and cc_type != CONFIDENTIAL_ROOM_TYPE:
        return False

    initial_state = request_content.get("initial_state")
    if not isinstance(initial_state, list):
        initial_state = []
    have = {
        (s.get("type"), s.get("state_key", ""))
        for s in initial_state
        if isinstance(s, dict)
    }
    for state in build_confidential_initial_state():
        if (state["type"], state["state_key"]) not in have:
            initial_state.append(state)
    request_content["initial_state"] = initial_state
    return True


# --- Duenne Synapse-Bruecke (flag-gegated registriert) ---------------------


class E2eeGuard:
    """Kapselt den ThirdPartyRules-`check_event_allowed`-Callback."""

    @staticmethod
    def _extract_create_content(state_events: Any) -> dict[str, Any] | None:
        """Holt den m.room.create-Content aus der State-Map (defensiv)."""
        if state_events is None:
            return None
        create_event = None
        getter = getattr(state_events, "get", None)
        if callable(getter):
            create_event = getter((_CREATE_EVENT, ""))
        if create_event is None:
            return None
        content = getattr(create_event, "content", None)
        # frozendict/immutabledict → Mapping, nicht dict (s. _as_mapping).
        return _as_mapping(content)

    async def check_event_allowed(
        self, event: Any, state_events: Any
    ) -> "tuple[bool, dict[str, Any] | None]":
        """
        ThirdPartyRules-Hook. Laeuft auf JEDEM State-Event der Instanz.

        Differenziertes Fail-Verhalten (Review 2026-07-16, Punkt 2):
        - Der Schnell-Pfad fuer ALLES ausser Encryption/Marker liegt VOR dem
          try und kann nicht werfen → normaler Chatbetrieb wird von einem
          Guard-Bug NIE blockiert (fail-open, richtig fuer 99,99% des Traffics).
        - Ab hier ist das Event E2EE-relevant. Eine Exception hier ist ein
          reiner Code-Bug (KEIN Backend-Call im Spiel) → **fail-CLOSED**
          (ablehnen), sonst oeffnet genau ein Bug der frozendict-Klasse still
          die Footgun, die der Guard schliesst. Zusaetzlich **CRITICAL-Alarm**
          mit eindeutigem Tag `E2EE-GUARD-EXCEPTION` — Monitoring (AP-2.3) MUSS
          darauf paging ausloesen; ein Log, das niemand liest, ist kein Netz.
        """
        event_type = getattr(event, "type", None)
        if event_type not in (_ENCRYPTION_EVENT, CONFIDENTIAL_MARKER_EVENT):
            return (True, None)

        try:
            event_content = getattr(event, "content", None)
            create_content = self._extract_create_content(state_events)
            allowed = evaluate_event(event_type, event_content, create_content)
            if not allowed:
                logger.warning(
                    "E2EE-Guard: rejected %s (confidential=%s) in room %s",
                    event_type,
                    is_confidential_create_content(create_content),
                    getattr(event, "room_id", "?"),
                )
            return (allowed, None)
        except Exception as exc:  # noqa: BLE001
            logger.critical(
                "E2EE-GUARD-EXCEPTION (fail-closed, ALERT): %s on %s in room %s",
                exc,
                event_type,
                getattr(event, "room_id", "?"),
            )
            return (False, None)
