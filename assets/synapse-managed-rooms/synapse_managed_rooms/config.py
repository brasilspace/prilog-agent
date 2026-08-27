"""Configuration — fail closed.

Default stance: all six actions are denied when ``deny`` is omitted. Anyone
enabling a module called "managed rooms" wants the closed door, not one they can
forget to close.

Every configuration error aborts the Synapse start. A security configuration
that swallows typos is not one.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

ACTIONS: tuple[str, ...] = (
    "create_room",
    "invite",
    "3pid_invite",
    "join_room",
    "create_room_alias",
    "publish_room",
)


class ConfigError(Exception):
    """Raised at startup, which stops Synapse.

    Synapse catches exceptions from ``parse_config`` and aborts the start with
    the message. That is the intent: better a server that refuses to start than
    one that runs with a half-understood rule and an open door.
    """


@dataclass(frozen=True)
class ExemptRule:
    """An exemption for a service account of the leading system."""

    pattern: re.Pattern[str]
    allow: frozenset[str]
    raw_match: str

    def matches(self, user_id: str) -> bool:
        return self.pattern.fullmatch(user_id) is not None


@dataclass(frozen=True)
class ManagedRoomsConfig:
    deny: frozenset[str]
    exempt: tuple[ExemptRule, ...] = ()
    allow_direct_messages: bool = False
    allow_invited_joins: bool = True
    direct_message_max_participants: int = 2
    _warnings: tuple[str, ...] = field(default=(), repr=False)


def _require_mapping(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{where}: expected a mapping, got {type(value).__name__}")
    return value


def _require_action_list(value: Any, where: str) -> frozenset[str]:
    if isinstance(value, str) or not isinstance(value, Iterable):
        raise ConfigError(f"{where}: expected a list of actions")
    actions = list(value)
    unknown = [a for a in actions if a not in ACTIONS]
    if unknown:
        raise ConfigError(
            f"{where}: unknown action(s) {unknown!r}. Valid actions are: {', '.join(ACTIONS)}"
        )
    return frozenset(actions)


def _check_pattern(raw: str) -> re.Pattern[str]:
    if not isinstance(raw, str) or not raw:
        raise ConfigError("exempt[].match: expected a non-empty pattern")
    if not raw.startswith("@"):
        raise ConfigError(
            f"exempt[].match {raw!r}: a Matrix ID pattern starts with '@'. "
            "The complete ID is matched with re.fullmatch."
        )
    try:
        return re.compile(raw)
    except re.error as exc:
        raise ConfigError(
            f"exempt[].match {raw!r}: not a valid regular expression ({exc})"
        ) from exc


def _server_name_left_open(raw: str) -> bool:
    """Patterns that leave the server part wide open.

    With federation enabled, any remote server could create an account with a
    matching localpart and inherit the exemption. That is not a style issue,
    that is an open gate.
    """
    colon = raw.rfind(":")
    if colon == -1:
        return True
    rest = raw[colon + 1 :]
    return rest in ("", ".*", ".+", ".*$", ".+$")


def parse_config(config: Any) -> ManagedRoomsConfig:
    """Read and validate the module configuration. Raises on any doubt."""

    config = _require_mapping(config or {}, "config")

    unknown_keys = set(config) - {
        "deny",
        "exempt",
        "allow_direct_messages",
        "allow_invited_joins",
        "direct_message_max_participants",
    }
    if unknown_keys:
        raise ConfigError(
            f"config: unknown key(s) {sorted(unknown_keys)!r}. Typos are not silently ignored."
        )

    if "deny" in config:
        deny = _require_action_list(config["deny"], "config.deny")
    else:
        deny = frozenset(ACTIONS)

    warnings: list[str] = []
    rules: list[ExemptRule] = []
    raw_exemptions = config.get("exempt") or []
    if isinstance(raw_exemptions, str) or not isinstance(raw_exemptions, Iterable):
        raise ConfigError("config.exempt: expected a list of rules")

    for i, raw_rule in enumerate(raw_exemptions):
        raw_rule = _require_mapping(raw_rule, f"config.exempt[{i}]")
        extra = set(raw_rule) - {"match", "allow"}
        if extra:
            raise ConfigError(f"config.exempt[{i}]: unknown key(s) {sorted(extra)!r}")
        if "match" not in raw_rule:
            raise ConfigError(f"config.exempt[{i}]: 'match' is missing")
        raw_match = raw_rule["match"]
        pattern = _check_pattern(raw_match)
        allowed = _require_action_list(raw_rule.get("allow", []), f"config.exempt[{i}].allow")
        if _server_name_left_open(raw_match):
            raise ConfigError(
                f"config.exempt[{i}].match {raw_match!r}: the server name is left open. "
                "With federation enabled, any remote server could create an account with "
                "a matching localpart and inherit this exemption. Spell the server name "
                r"out, e.g. '@service-[a-z0-9]+:chat\.example'."
            )
        rules.append(ExemptRule(pattern=pattern, allow=allowed, raw_match=raw_match))

    if deny and not rules:
        warnings.append(
            "No exempt rule is configured. If your leading system creates rooms "
            "through a service account, it has just locked itself out."
        )

    allow_dms = config.get("allow_direct_messages", False)
    if not isinstance(allow_dms, bool):
        raise ConfigError("config.allow_direct_messages: expected true or false")

    allow_invited_joins = config.get("allow_invited_joins", True)
    if not isinstance(allow_invited_joins, bool):
        raise ConfigError("config.allow_invited_joins: expected true or false")
    if "join_room" in deny and not allow_invited_joins:
        warnings.append(
            "join_room is denied and allow_invited_joins is off. Users can then no "
            "longer accept invitations - including those your leading system sends "
            "on their behalf through the admin API, which joins as the invited user, "
            "not as the admin. Only do this if you know why."
        )

    participants = config.get("direct_message_max_participants", 2)
    if not isinstance(participants, int) or isinstance(participants, bool) or participants != 2:
        raise ConfigError(
            "config.direct_message_max_participants: only 2 is supported today. "
            "The key exists so that a future extension cannot become a silent "
            "change in behaviour."
        )

    if allow_dms and "invite" not in deny and "create_room" not in deny:
        warnings.append(
            "allow_direct_messages is on, but neither create_room nor invite is "
            "denied - the exception has nothing to do."
        )

    return ManagedRoomsConfig(
        deny=deny,
        exempt=tuple(rules),
        allow_direct_messages=allow_dms,
        allow_invited_joins=allow_invited_joins,
        direct_message_max_participants=participants,
        _warnings=tuple(warnings),
    )
