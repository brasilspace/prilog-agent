from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from .e2ee_guard import E2eeGuard, apply_confidential_creation
from .helpers import build_creation_payload
from .policy_client import ConnectorPolicyError, PolicyClient

try:
    from synapse.api.errors import Codes, SynapseError
except Exception:  # pragma: no cover - local tests run without Synapse installed.
    Codes = None

    class SynapseError(Exception):
        def __init__(self, code: int, msg: str, errcode: str | None = None) -> None:
            super().__init__(msg)
            self.code = code
            self.msg = msg
            self.errcode = errcode


logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ConnectorModuleConfig:
    prilog_api_url: str
    shared_secret: str
    tenant_id: str | None
    tenant_key: str | None
    subdomain: str | None
    allow_server_admin_bypass: bool
    request_timeout_seconds: float
    # JWT-Login (seit 2026-05-12): separates Secret fuer HMAC-SHA256-JWTs,
    # die vom Prilog-Backend gemintet werden. Wenn gesetzt, registriert der
    # Connector den Password-Auth-Provider — Login akzeptiert dann statt
    # Klartext-Passwort ein JWT mit { sub: <local_part>, exp, iss } und
    # verifiziert es lokal. Synapse-localdb-Password bleibt parallel
    # nutzbar bis `password_config.localdb_enabled: false` gesetzt wird.
    jwt_secret: str | None
    jwt_issuer: str
    # E2EE-Encryption-/Marker-Guard (AP-3.4). Default AUS: bis der destruktive
    # Bestaetigungstest auf einem Wegwerf-Synapse gefahren ist (Owner-Entscheid
    # B), aendert ein Connector-Update NICHTS am Verhalten der Live-Tenants.
    e2ee_guard_enabled: bool = False


class PrilogMatrixConnectorModule:
    def __init__(self, config: ConnectorModuleConfig, api: Any) -> None:
        self._config = config
        self._api = api
        self._policy_client = PolicyClient(
            base_url=config.prilog_api_url,
            shared_secret=config.shared_secret,
            timeout_seconds=config.request_timeout_seconds,
        )
        self._e2ee_guard = E2eeGuard()

        self._register_callbacks()

    @staticmethod
    def parse_config(config: dict[str, Any]) -> ConnectorModuleConfig:
        prilog_api_url = str(config.get("prilog_api_url") or "").strip().rstrip("/")
        shared_secret = str(config.get("shared_secret") or "").strip()
        tenant_id = str(config.get("tenant_id") or "").strip() or None
        tenant_key = str(config.get("tenant_key") or "").strip() or None
        subdomain = str(config.get("subdomain") or "").strip() or None
        allow_server_admin_bypass = bool(config.get("allow_server_admin_bypass", True))
        request_timeout_seconds = float(config.get("request_timeout_seconds", 5.0))
        jwt_secret = str(config.get("jwt_secret") or "").strip() or None
        jwt_issuer = str(config.get("jwt_issuer") or "prilog-backend").strip()
        e2ee_guard_enabled = bool(config.get("e2ee_guard_enabled", False))

        if not prilog_api_url:
            raise ValueError("prilog_api_url is required")
        if not prilog_api_url.startswith("https://") and not prilog_api_url.startswith("http://localhost"):
            logger.warning("prilog_api_url does not use HTTPS: %s — this is insecure in production", prilog_api_url)
        if not shared_secret:
            raise ValueError("shared_secret is required")
        if not (tenant_id or tenant_key or subdomain):
            raise ValueError("tenant_id, tenant_key or subdomain is required")

        return ConnectorModuleConfig(
            prilog_api_url=prilog_api_url,
            shared_secret=shared_secret,
            tenant_id=tenant_id,
            tenant_key=tenant_key,
            subdomain=subdomain,
            allow_server_admin_bypass=allow_server_admin_bypass,
            request_timeout_seconds=request_timeout_seconds,
            jwt_secret=jwt_secret,
            jwt_issuer=jwt_issuer,
            e2ee_guard_enabled=e2ee_guard_enabled,
        )

    def _register_callbacks(self) -> None:
        if hasattr(self._api, "register_third_party_rules_callbacks"):
            # on_create_room: blockierender Pre-Check fuer Raum-Erstellung.
            # on_new_event: read-only Post-Hook nach jedem persistierten Event —
            # wir nutzen ihn fuer die Voice-Transkription bei m.audio. Read-only
            # heisst der Hook kann den Event nicht beeinflussen, was perfekt
            # ist: Audio ist schon im Chat zugestellt, Transkription ist ein
            # Bonus, der hinterher kommt.
            callbacks: dict[str, Any] = {
                "on_create_room": self.on_create_room,
                "on_new_event": self.on_new_event,
            }
            # E2EE-Guard (AP-3.4) nur registrieren, wenn explizit aktiviert —
            # sonst laeuft check_event_allowed gar nicht erst mit (inert).
            if self._config.e2ee_guard_enabled:
                callbacks["check_event_allowed"] = self._e2ee_guard.check_event_allowed
            self._api.register_third_party_rules_callbacks(**callbacks)
            logger.info(
                "Registered third_party_rules callbacks for Prilog Matrix Connector "
                "(e2ee_guard=%s)",
                self._config.e2ee_guard_enabled,
            )
        else:
            logger.warning(
                "ModuleApi has no register_third_party_rules_callbacks; "
                "connector room policy inactive and mobile room creation will remain unmanaged"
            )

        # Password-Auth-Provider (seit 2026-05-12): wenn jwt_secret konfiguriert
        # ist, akzeptieren wir Logins, deren "password"-Feld ein gueltiges
        # HS256-JWT ist. Synapse-localdb-Password kann parallel deaktiviert
        # werden via password_config.localdb_enabled: false — dann ist der
        # einzige Login-Weg ueber JWT, das nur das Prilog-Backend minten kann.
        # Element & Co. mit Klartext-Passwort werden abgelehnt.
        if self._config.jwt_secret and hasattr(self._api, "register_password_auth_provider_callbacks"):
            self._api.register_password_auth_provider_callbacks(
                auth_checkers={
                    ("m.login.password", ("password",)): self._check_jwt_password,
                },
            )
            logger.info(
                "Registered password_auth_provider callback (HS256 JWT) for Prilog Matrix Connector"
            )
        elif self._config.jwt_secret:
            logger.error(
                "jwt_secret configured but ModuleApi lacks register_password_auth_provider_callbacks; "
                "JWT-Login NOT active"
            )

    async def _check_jwt_password(
        self,
        username: str,
        login_type: str,
        login_dict: "dict[str, Any]",
    ) -> "tuple[str, Any] | None":
        """
        Synapse-Hook: empfaengt einen m.login.password-Versuch und versucht
        das "password"-Feld als HS256-JWT zu verifizieren. Bei Erfolg gibt
        sie die Matrix-User-ID zurueck und Synapse erzeugt einen access_token.
        Bei Misserfolg gibt sie None zurueck — Synapse versucht dann den
        naechsten Auth-Mechanismus (localdb falls aktiv).

        JWT-Claims:
          - sub: Local-Part der erwarteten User-ID (z.B. "adminleander")
          - exp: Unix-Timestamp (max 5 min in der Zukunft akzeptiert)
          - iss: muss self._config.jwt_issuer matchen
        """
        logger.debug("JWT-Hook ENTRY: username=%s login_type=%s", username, login_type)

        import hmac
        import hashlib
        import base64
        import json
        import time

        token = (login_dict.get("password") or "").strip()
        if not token or token.count(".") != 2:
            return None  # nicht JWT-Format → naechster Provider darf ran

        try:
            header_b64, payload_b64, sig_b64 = token.split(".")

            def b64decode(s: str) -> bytes:
                # base64url-Decoding mit Padding-Auffuellung
                pad = "=" * (-len(s) % 4)
                return base64.urlsafe_b64decode(s + pad)

            # Header pruefen
            header = json.loads(b64decode(header_b64))
            if header.get("alg") != "HS256" or header.get("typ") != "JWT":
                return None

            # Signatur pruefen — constant-time-Compare
            expected_sig = hmac.new(
                self._config.jwt_secret.encode("utf-8"),
                f"{header_b64}.{payload_b64}".encode("utf-8"),
                hashlib.sha256,
            ).digest()
            expected_sig_b64 = base64.urlsafe_b64encode(expected_sig).rstrip(b"=").decode("ascii")
            if not hmac.compare_digest(sig_b64, expected_sig_b64):
                logger.warning("JWT-Login: signature mismatch for sub=%s", username)
                return None

            # Payload validieren
            payload = json.loads(b64decode(payload_b64))
            now = int(time.time())

            if payload.get("iss") != self._config.jwt_issuer:
                logger.warning("JWT-Login: issuer mismatch: %s != %s", payload.get("iss"), self._config.jwt_issuer)
                return None

            exp = payload.get("exp")
            if not isinstance(exp, (int, float)) or exp < now:
                logger.warning("JWT-Login: token expired (exp=%s, now=%s)", exp, now)
                return None
            if exp > now + 300:
                logger.warning("JWT-Login: token too far in future (exp=%s)", exp)
                return None

            sub = payload.get("sub")
            if not isinstance(sub, str) or not sub:
                return None

            # Synapse uebergibt `username` als full user_id ("@local:domain")
            # ODER als Local-Part. Wir matchen den Local-Part aus beiden.
            expected_local = username.lstrip("@").split(":")[0]
            if sub != expected_local:
                logger.warning("JWT-Login: sub mismatch: %s != %s", sub, expected_local)
                return None

            # Synapse erwartet eine full user_id zurueck
            server_name = self._api.server_name if hasattr(self._api, "server_name") else None
            full_user_id = (
                username if username.startswith("@") else
                f"@{sub}:{server_name}" if server_name else f"@{sub}:localhost"
            )

            logger.info("JWT-Login OK for %s", full_user_id)
            return (full_user_id, None)
        except Exception as exc:  # noqa: BLE001
            logger.warning("JWT-Login: unexpected error: %s", exc)
            return None

    async def on_create_room(
        self,
        requester: Any,
        request_content: dict[str, Any],
        is_requester_admin: bool,
    ) -> None:
        # AP-3.4: Erstellung ist die Wahrheit — legt der Request einen
        # Vertraulichen Chat an, Encryption + Marker autoritativ injizieren,
        # BEVOR der Admin-Bypass greift (Prilog erstellt Raeume via Admin).
        # Kein Raum kann so als vertraulich gelten und Klartext sein.
        if self._config.e2ee_guard_enabled and apply_confidential_creation(request_content):
            logger.info("E2EE-Guard: injected encryption+marker into confidential room creation")

        if self._config.allow_server_admin_bypass and is_requester_admin:
            logger.info("Allowing room creation for server admin due to allow_server_admin_bypass")
            return

        matrix_user_id = self._extract_matrix_user_id(requester)
        payload = build_creation_payload(
            tenant_id=self._config.tenant_id,
            tenant_key=self._config.tenant_key,
            subdomain=self._config.subdomain,
            matrix_user_id=matrix_user_id,
            config=request_content,
        )

        logger.debug(
            "Connector creation request for %s: kind=%s visibility=%s room_type=%s parent=%s",
            matrix_user_id,
            payload.get("creationKind"),
            payload.get("visibility"),
            payload.get("roomType"),
            payload.get("requestedParentMatrixRoomId"),
        )

        try:
            decision = self._policy_client.creation_decision(payload)
        except ConnectorPolicyError as exc:
            logger.error("Connector policy request failed for %s: %s", matrix_user_id, exc)
            raise SynapseError(503, "Prilog connector policy service unavailable", errcode="M_UNKNOWN")

        if decision.allow:
            logger.info(
                "Allowed %s creation for %s with role=%s",
                payload["creationKind"],
                matrix_user_id,
                decision.effective_instance_role,
            )
            return

        logger.warning(
            "Denied %s creation for %s: %s",
            payload["creationKind"],
            matrix_user_id,
            decision.reason,
        )

        raise SynapseError(
            403,
            decision.reason,
            errcode=Codes.FORBIDDEN if Codes else "M_FORBIDDEN",
        )

    async def on_new_event(self, event: Any, state_events: Any) -> None:
        """
        Read-only Post-Hook fuer jedes persistierte Event. Wir filtern auf
        m.room.message mit msgtype=m.audio und triggern fire-and-forget
        die Transkription. Synapse waertet den Return-Wert nicht aus —
        wir muessen aber sauber returnen, damit es nicht zu Logspam kommt.

        Filterung muss SEHR fruehzeitig sein, damit wir nicht bei jedem
        Text-Event Backend-Calls absetzen. Das hier laeuft auf JEDEM Event
        in JEDEM Raum auf der gesamten Synapse-Instanz.
        """
        try:
            event_type = getattr(event, "type", None)
            if event_type != "m.room.message":
                return

            content = getattr(event, "content", None) or {}
            if not isinstance(content, dict):
                return

            msgtype = content.get("msgtype")
            if msgtype != "m.audio":
                return

            # Edits / Replacements ueberspringen — sonst transkribieren wir
            # einen Edit-Stub erneut.
            relates_to = content.get("m.relates_to")
            if isinstance(relates_to, dict) and relates_to.get("rel_type") == "m.replace":
                return

            mxc_uri = content.get("url")
            if not isinstance(mxc_uri, str) or not mxc_uri.startswith("mxc://"):
                return

            sender = getattr(event, "sender", None)
            if not isinstance(sender, str):
                return

            room_id = getattr(event, "room_id", None)
            if not isinstance(room_id, str):
                return

            event_id = getattr(event, "event_id", None)
            if not isinstance(event_id, str):
                return

            # Bot-Sender ueberspringen — der Bot postet u. a. das Transkript
            # selbst; nie dessen (etwaige) Audios transkribieren.
            #
            # Der Tenant-Admin (@admin:) wird BEWUSST NICHT mehr uebersprungen:
            # der Operator testet Flurfunk regelmaessig als Admin, und das
            # Backend whitelistet den Tenant-Admin ohnehin schon
            # (transcribe.service `isSenderTenantAdmin` -> canUseTranscription-
            # Check wird uebersprungen). Ihn hier vorab wegzuwerfen war die
            # wiederkehrende Ursache fuer "Flurfunk geht nicht" (Attempt wurde
            # nie angelegt, Diagnose-Tool blieb leer). Das Transkript selbst ist
            # eine Text-Nachricht (org.prilog.transcript_text), kein m.audio ->
            # kein Loop.
            if sender.startswith("@bot:"):
                return

            # tenant_key fuer das Backend — wir nehmen die statische Config aus
            # diesem Modul-Setup. Eine Synapse-Instanz = ein Tenant.
            tenant_key = self._config.tenant_key or self._config.subdomain
            if not tenant_key:
                logger.warning(
                    "on_new_event: cannot determine tenant_key for transcription, skipping"
                )
                return

            info = content.get("info") if isinstance(content.get("info"), dict) else {}
            duration_ms = info.get("duration") if isinstance(info, dict) else None
            duration_sec: float | None = None
            if isinstance(duration_ms, (int, float)) and duration_ms > 0:
                # Matrix-Spec: info.duration ist in Millisekunden
                duration_sec = float(duration_ms) / 1000.0

            payload = {
                "tenantKey": tenant_key,
                "roomId": room_id,
                "eventId": event_id,
                "mxcUri": mxc_uri,
                "sender": sender,
                "filename": content.get("body") if isinstance(content.get("body"), str) else None,
                "mimetype": info.get("mimetype") if isinstance(info, dict) else None,
            }
            if duration_sec is not None:
                payload["durationSec"] = duration_sec

            # Felder mit None entfernen — Backend Zod-Schema akzeptiert keine
            # explicit nulls fuer optional fields.
            payload = {k: v for k, v in payload.items() if v is not None}

            logger.info(
                "Triggering voice transcription: room=%s event=%s sender=%s duration=%ss",
                room_id,
                event_id,
                sender,
                duration_sec,
            )

            # Fire-and-forget — wir warten nicht auf den Backend-Round-Trip
            # damit on_new_event Synapse nicht blockiert.
            try:
                self._policy_client.transcribe_voice(payload)
            except Exception as exc:  # noqa: BLE001
                logger.warning("transcribe_voice call failed (non-blocking): %s", exc)
        except Exception as exc:  # noqa: BLE001
            # Niemals werfen — on_new_event ist read-only und darf das Event
            # nicht beeinflussen, aber Exceptions koennen Synapse-Logs voll-
            # spammen.
            logger.warning("on_new_event handler error (ignored): %s", exc)

    @staticmethod
    def _extract_matrix_user_id(requester: Any) -> str:
        user = getattr(requester, "user", None)
        if user is not None:
            to_string = getattr(user, "to_string", None)
            if callable(to_string):
                return str(to_string())
            user_id = getattr(user, "user_id", None)
            if isinstance(user_id, str):
                return user_id

        requester_value = getattr(requester, "requester", None)
        if isinstance(requester_value, str):
            return requester_value

        if isinstance(requester, str) and requester.strip():
            return requester.strip()

        raise SynapseError(400, "Requester could not be resolved", errcode="M_BAD_JSON")
