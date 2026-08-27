"""The direct-message exception — the only place this module lets through
something it would otherwise deny.

It has two halves, and **both** must hold: on ``POST /createRoom`` Synapse asks
``user_may_create_room``, and then asks ``user_may_invite`` for every invitee in
the same call. Opening only the first half produces a room whose invitation
fails one line later — a direct chat where nobody ever arrives. That is worse
than a clean refusal.

On the invite side Synapse hands the callback only ``(inviter, invitee,
room_id)`` — no config, no ``is_direct``. So the module reads the **room state**
there. The load-bearing condition is the number of members with membership
``join`` **or** ``invite``: it must be exactly 1, namely the inviter themselves.

Why ``invite`` is counted: if only joined members were counted, A could create a
direct room, invite B (still only A has joined) and then push C, D and E through
the very same check. The result would be a five-person group built entirely
through the exception path. Counting ``join + invite`` ends it after the first
invitation.

And because ``leave`` appears in neither count, one case falls out for free: if
the other person leaves the room, the count drops back to 1 and they may be
invited again.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

CREATE = ("m.room.create", "")
NAME = ("m.room.name", "")
CANONICAL_ALIAS = ("m.room.canonical_alias", "")
JOIN_RULES = ("m.room.join_rules", "")
MEMBER = "m.room.member"

# State events a client may send along when creating a direct message. Anything
# else turns the room into something that is no longer a direct message. This is
# an allow-list rather than a block-list, so that a future event type cannot slip
# through unnoticed.
ALLOWED_INITIAL_STATE: dict[str, frozenset[str] | None] = {
    "m.room.encryption": None,
    "m.room.history_visibility": frozenset({"invited", "joined", "shared"}),
    "m.room.guest_access": frozenset({"forbidden"}),
}

# `creation_content` may carry nothing but the harmless. In particular `type` is
# off limits: that would turn the direct message into a space.
ALLOWED_CREATION_CONTENT_KEYS = frozenset({"m.federate"})

ALLOWED_PRESETS = frozenset({"private_chat", "trusted_private_chat"})


@dataclass(frozen=True)
class Check:
    """Result of a check.

    ``reason`` is for the log, not for the requesting user — the message shown
    to the client is fixed by Synapse and cannot be replaced by a callback.
    """

    ok: bool
    reason: str

    def __bool__(self) -> bool:
        return self.ok


PASSED = Check(True, "")


def _as_sequence(value: Any) -> Sequence[Any]:
    if value is None:
        return ()
    if isinstance(value, (list, tuple)):
        return value
    return (value,)


def check_creation(room_config: Mapping[str, Any]) -> Check:
    """Is this the create call for a genuine two-person direct message?

    ``is_direct`` alone is not enough — that is a claim made by the client. What
    is checked is whether the requested room has the *shape* of a direct
    message: exactly one invitee, no name, no alias, not public, and nothing
    hidden in ``initial_state`` or ``creation_content``.
    """

    if not isinstance(room_config, Mapping):
        return Check(False, "room_config is not a mapping")

    if room_config.get("is_direct") is not True:
        return Check(False, "is_direct is not set")

    invitees = _as_sequence(room_config.get("invite"))
    if len(invitees) != 1:
        return Check(False, f"expected exactly one invitee, found {len(invitees)}")
    if not isinstance(invitees[0], str) or not invitees[0].startswith("@"):
        return Check(False, "the invitee is not a Matrix ID")

    if _as_sequence(room_config.get("invite_3pid")):
        return Check(False, "third-party invites are not part of this exception")

    if room_config.get("name"):
        return Check(False, "a direct message has no name")
    if room_config.get("room_alias_name"):
        return Check(False, "a direct message has no alias")
    if room_config.get("visibility", "private") != "private":
        return Check(False, "a direct message is not publicly listed")

    preset = room_config.get("preset")
    if preset is not None and preset not in ALLOWED_PRESETS:
        return Check(False, f"preset {preset!r} is not a direct message")

    creation_content = room_config.get("creation_content") or {}
    if not isinstance(creation_content, Mapping):
        return Check(False, "creation_content is not a mapping")
    extra = set(creation_content) - ALLOWED_CREATION_CONTENT_KEYS
    if extra:
        return Check(False, f"creation_content carries {sorted(extra)!r}")

    # The route by which a name or join_rules moves one level down and walks
    # past a check that only looks at top-level fields.
    for i, event in enumerate(_as_sequence(room_config.get("initial_state"))):
        if not isinstance(event, Mapping):
            return Check(False, f"initial_state[{i}] is not a mapping")
        event_type = event.get("type")
        if event_type not in ALLOWED_INITIAL_STATE:
            return Check(False, f"initial_state[{i}] sets {event_type!r}")
        if event.get("state_key", "") != "":
            return Check(False, f"initial_state[{i}] has a state_key")
        allowed_values = ALLOWED_INITIAL_STATE[event_type]
        if allowed_values is None:
            continue
        content = event.get("content") or {}
        if not isinstance(content, Mapping):
            return Check(False, f"initial_state[{i}].content is not a mapping")
        values = {v for v in content.values() if isinstance(v, str)}
        if not values <= allowed_values:
            return Check(
                False,
                f"initial_state[{i}] ({event_type}) sets {sorted(values - allowed_values)!r}",
            )

    return PASSED


def check_invite(state: Mapping[tuple[str, str], Any], inviter: str) -> Check:
    """May an invitation be sent in this room right now?

    ``state`` is the current room state as a mapping ``(type, state_key) ->
    event`` — the shape returned by ``ModuleApi.get_room_state``.
    """

    creation = state.get(CREATE)
    if creation is None:
        return Check(False, "no m.room.create in room state")
    if _sender(creation) != inviter:
        return Check(False, "the room does not belong to the inviter")
    if (_content(creation) or {}).get("type") is not None:
        return Check(False, "not an ordinary room (creation_content.type)")

    if NAME in state:
        return Check(False, "the room has a name")
    if CANONICAL_ALIAS in state:
        return Check(False, "the room has an alias")

    rule = state.get(JOIN_RULES)
    if rule is None or (_content(rule) or {}).get("join_rule") != "invite":
        return Check(False, "the room is not invite-only")

    occupied: list[str] = []
    for (event_type, state_key), event in state.items():
        if event_type != MEMBER:
            continue
        if (_content(event) or {}).get("membership") in ("join", "invite"):
            occupied.append(state_key)

    if occupied != [inviter]:
        return Check(
            False,
            "the room is no longer empty: "
            f"{sorted(occupied)!r} (join or invite) - the exception applies once per room",
        )

    return PASSED


def _sender(event: Any) -> str | None:
    if isinstance(event, Mapping):
        return event.get("sender")
    sender = getattr(event, "sender", None)
    return sender if isinstance(sender, str) else None


def _content(event: Any) -> Mapping[str, Any] | None:
    if isinstance(event, Mapping):
        content = event.get("content")
    else:
        content = getattr(event, "content", None)
    return content if isinstance(content, Mapping) else None
