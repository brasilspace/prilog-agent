"""synapse-managed-rooms — rooms are created in the leading system, not beside it.

The module closes the six routes by which end users can create rooms, invite
people or make rooms discoverable behind the back of a leading system. Service
accounts of that system are explicitly exempted.

It reads no messages. It scores no content. It merely uses the same interface a
spam checker uses.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from ._compat import NOT_SPAM, Codes
from .config import ManagedRoomsConfig, parse_config
from .direct_messages import Check, check_creation, check_invite

logger = logging.getLogger(__name__)

Verdict = Any  # NOT_SPAM | Codes


class ManagedRoomsModule:
    """Hooked in through ``modules:`` in ``homeserver.yaml``."""

    def __init__(self, config: ManagedRoomsConfig, api: Any) -> None:
        self._config = config
        self._api = api

        for warning in config._warnings:
            logger.warning("[managed-rooms] %s", warning)

        api.register_spam_checker_callbacks(
            user_may_create_room=self.user_may_create_room,
            user_may_invite=self.user_may_invite,
            user_may_send_3pid_invite=self.user_may_send_3pid_invite,
            user_may_join_room=self.user_may_join_room,
            user_may_create_room_alias=self.user_may_create_room_alias,
            user_may_publish_room=self.user_may_publish_room,
        )

        logger.info(
            "[managed-rooms] active - denied: %s | exemptions: %d | direct messages: %s",
            ", ".join(sorted(config.deny)) or "nothing",
            len(config.exempt),
            "allowed" if config.allow_direct_messages else "no",
        )

    # Called by Synapse at startup; any exception here stops the server.
    @staticmethod
    def parse_config(config: Any) -> ManagedRoomsConfig:
        return parse_config(config)

    # --- the six doors --------------------------------------------------------

    async def user_may_create_room(self, user_id: str, room_config: Mapping[str, Any]) -> Verdict:
        """Signature since Synapse 1.132: ``room_config`` is passed along, and
        the callback also fires on room upgrades.

        Synapse still accepts the older one-argument form. Using it raises no
        error — it just silently withholds ``room_config``, and with it the
        direct-message check. See tests/integration.
        """
        verdict = self._verdict("create_room", user_id)
        if verdict is NOT_SPAM:
            return NOT_SPAM
        if self._config.allow_direct_messages:
            check = check_creation(room_config or {})
            if check.ok:
                logger.debug("[managed-rooms] %s is creating a direct message", user_id)
                return NOT_SPAM
            logger.info(
                "[managed-rooms] create_room denied for %s (not a direct message: %s)",
                user_id,
                check.reason,
            )
        return verdict

    async def user_may_invite(self, inviter: str, invitee: str, room_id: str) -> Verdict:
        verdict = self._verdict("invite", inviter)
        if verdict is NOT_SPAM:
            return NOT_SPAM
        if self._config.allow_direct_messages:
            check = await self._may_invite_into_direct_room(inviter, room_id)
            if check.ok:
                logger.debug("[managed-rooms] %s is inviting into direct room %s", inviter, room_id)
                return NOT_SPAM
            logger.info(
                "[managed-rooms] invite denied for %s in %s (%s)", inviter, room_id, check.reason
            )
        return verdict

    async def user_may_send_3pid_invite(
        self, inviter: str, medium: str, address: str, room_id: str
    ) -> Verdict:
        # There is deliberately no direct-message exception for third-party
        # identifiers: at check time the invitee is not yet a known person.
        return self._verdict("3pid_invite", inviter)

    async def user_may_join_room(self, user: str, room: str, is_invited: bool) -> Verdict:
        """Joining a room.

        Two things about this callback are easy to get wrong and expensive:

        1. For server admins Synapse does not call it at all — the ONLY built-in
           admin exemption. See README §1.
        2. It fires when someone *accepts an invitation* too, and it fires with
           the **invited user** as the requester even when a server admin issued
           the join through ``/_synapse/admin/v1/join`` — that endpoint joins with
           a requester faked to be the target user (``rest/admin/rooms.py``), so
           the admin exemption does not apply there either.

        Which is why ``allow_invited_joins`` defaults to on: the invitation is
        the decision, and this module already gates invitations. Denying the join
        that follows protects nothing and breaks everything — a leading system
        placing its own users into rooms, and anyone accepting a direct message.
        Joining *without* an invitation — walking into a public or knockable room
        — is the side door, and that stays shut.
        """
        if is_invited and self._config.allow_invited_joins:
            return NOT_SPAM
        return self._verdict("join_room", user)

    async def user_may_create_room_alias(self, user_id: str, room_alias: Any) -> Verdict:
        return self._verdict("create_room_alias", user_id)

    async def user_may_publish_room(self, user_id: str, room_id: str) -> Verdict:
        return self._verdict("publish_room", user_id)

    # --- rule evaluation ------------------------------------------------------

    def _verdict(self, action: str, user_id: str) -> Verdict:
        if action not in self._config.deny:
            return NOT_SPAM
        for rule in self._config.exempt:
            if rule.matches(user_id):
                return NOT_SPAM if action in rule.allow else Codes.FORBIDDEN
        return Codes.FORBIDDEN

    async def _may_invite_into_direct_room(self, inviter: str, room_id: str) -> Check:
        """Reads the room state. Failures mean refusal, never permission."""
        fetch: Callable[..., Awaitable[Any]] | None = getattr(self._api, "get_room_state", None)
        if fetch is None:  # pragma: no cover - only on a too-old Synapse
            return Check(False, "this Synapse version has no get_room_state")
        try:
            state = await fetch(
                room_id,
                [
                    ("m.room.create", ""),
                    ("m.room.name", ""),
                    ("m.room.canonical_alias", ""),
                    ("m.room.join_rules", ""),
                    ("m.room.member", None),
                ],
            )
        except Exception as exc:
            logger.warning(
                "[managed-rooms] room state of %s unreadable, invite denied: %s", room_id, exc
            )
            return Check(False, f"room state unreadable: {exc}")
        return check_invite(state, inviter)
