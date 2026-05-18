from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


logger = logging.getLogger(__name__)


class ConnectorPolicyError(RuntimeError):
    pass


@dataclass(slots=True)
class PolicyDecision:
    allow: bool
    reason: str
    effective_instance_role: str | None
    required_capability: str | None
    observed_management_mode: str | None
    payload: dict[str, Any]


class PolicyClient:
    def __init__(self, base_url: str, shared_secret: str, timeout_seconds: float = 5.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._shared_secret = shared_secret
        self._timeout_seconds = timeout_seconds

    def creation_decision(self, payload: dict[str, Any]) -> PolicyDecision:
        body = json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self._base_url}/api/matrix-connector/policies/creation",
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Matrix-Connector-Secret": self._shared_secret,
            },
            method="POST",
        )

        try:
            with urlopen(request, timeout=self._timeout_seconds) as response:
                content = response.read().decode("utf-8")
        except HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            raise ConnectorPolicyError(f"Policy endpoint rejected request: {exc.code} {details}") from exc
        except URLError as exc:
            raise ConnectorPolicyError(f"Policy endpoint unreachable: {exc.reason}") from exc

        parsed = json.loads(content)
        decision = parsed.get("decision")
        if not isinstance(decision, dict):
            raise ConnectorPolicyError("Policy endpoint returned no decision payload")

        return PolicyDecision(
            allow=bool(decision.get("allow")),
            reason=str(decision.get("reason") or "Connector policy decision missing reason"),
            effective_instance_role=decision.get("effectiveInstanceRole")
            if isinstance(decision.get("effectiveInstanceRole"), str)
            else None,
            required_capability=decision.get("requiredCapability")
            if isinstance(decision.get("requiredCapability"), str)
            else None,
            observed_management_mode=decision.get("observedManagementMode")
            if isinstance(decision.get("observedManagementMode"), str)
            else None,
            payload=parsed,
        )

    def transcribe_voice(self, payload: dict[str, Any]) -> None:
        """
        Fire-and-forget POST an /api/matrix-connector/transcribe-voice.

        Das Backend antwortet sofort 202 (akzeptiert) und macht die
        Whisper-Transkription asynchron — wir warten hier nicht auf das
        Ergebnis. Wenn das Backend nicht erreichbar ist, loggen wir nur
        und ignorieren den Fehler. Transkription darf NIE den Audio-Flow
        blocken oder eskalieren.
        """
        body = json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self._base_url}/api/matrix-connector/transcribe-voice",
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Matrix-Connector-Secret": self._shared_secret,
            },
            method="POST",
        )

        try:
            # Kurzer Timeout — wir wollen nur den Request abschicken,
            # nicht auf die Verarbeitung warten. Das Backend gibt sofort
            # 202 zurueck, sobald der Job in der Queue ist.
            with urlopen(request, timeout=self._timeout_seconds) as response:
                response.read()  # drain
        except HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            logger.warning(
                "Transcribe-voice endpoint returned %d: %s",
                exc.code,
                details[:300],
            )
        except URLError as exc:
            logger.warning("Transcribe-voice endpoint unreachable: %s", exc.reason)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Transcribe-voice request failed: %s", exc)
