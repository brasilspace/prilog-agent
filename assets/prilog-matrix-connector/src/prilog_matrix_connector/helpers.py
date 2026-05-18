from __future__ import annotations

from typing import Any


def _as_non_empty_string(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            return stripped
    return None


def infer_creation_kind(config: dict[str, Any]) -> str:
    creation_content = config.get("creation_content")
    if isinstance(creation_content, dict) and creation_content.get("type") == "m.space":
        return "SPACE"

    if config.get("is_direct") is True:
        return "DIRECT_CHAT"

    return "ROOM"


def infer_visibility(config: dict[str, Any]) -> str:
    visibility = config.get("visibility")
    if isinstance(visibility, str) and visibility.lower() == "public":
        return "public"
    return "private"


def infer_room_type(config: dict[str, Any]) -> str | None:
    creation_content = config.get("creation_content")
    if isinstance(creation_content, dict):
        room_type = _as_non_empty_string(creation_content.get("type"))
        if room_type:
            return room_type
    return None


def infer_parent_room_id(config: dict[str, Any]) -> str | None:
    direct_parent = _as_non_empty_string(config.get("parent_room_id"))
    if direct_parent:
        return direct_parent

    initial_state = config.get("initial_state")
    if not isinstance(initial_state, list):
        return None

    for event in initial_state:
        if not isinstance(event, dict):
            continue
        if event.get("type") != "m.space.parent":
            continue
        state_key = _as_non_empty_string(event.get("state_key"))
        if state_key:
            return state_key

    return None


def build_creation_payload(
    *,
    tenant_id: str | None,
    tenant_key: str | None,
    subdomain: str | None,
    matrix_user_id: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "matrixUserId": matrix_user_id,
        "creationKind": infer_creation_kind(config),
        "visibility": infer_visibility(config),
        "roomType": infer_room_type(config),
        "requestedParentMatrixRoomId": infer_parent_room_id(config),
    }

    room_name = _as_non_empty_string(config.get("name"))
    if room_name:
        payload["name"] = room_name

    preset = _as_non_empty_string(config.get("preset"))
    if preset:
        payload["preset"] = preset

    if tenant_id:
        payload["tenantId"] = tenant_id
    if tenant_key:
        payload["tenantKey"] = tenant_key
    if subdomain:
        payload["subdomain"] = subdomain

    return payload
