# synapse-managed-rooms

A Synapse module for homeservers that are **not** the source of truth.

If you run Synapse behind a school platform, a company directory, an LMS or any
other leading system, that system decides who talks to whom. Matrix, by default,
does not know this: any end user can open Element, create a room, invite whoever
they like, and publish an alias. The result is rooms your leading system has
never heard of — and cannot govern, audit, or clean up.

This module closes those doors and lets your service accounts through.

It does **not** read messages, filter content, or moderate anything. It only
uses the same interface a spam checker uses.

> **Status:** 0.1.0, beta. Built for and running against Synapse 1.132+.
> Read [§1 Service accounts](#1-service-accounts-read-this-first) before you
> enable it, or you will lock your own platform out.

---

## 1. Service accounts — read this first

**There is exactly one built-in admin exemption in Synapse, and it is not the
one people assume.**

Verified against the Synapse 1.152.1 source, because this is the assumption that
breaks deployments:

| Callback | Skipped for server admins? | Where |
| --- | --- | --- |
| `user_may_join_room` | **yes** | `handlers/room_member.py` — `if not is_requester_admin` guards the check |
| `user_may_create_room` | no | `handlers/room.py:1225` — `if not is_requester_admin:` wraps the *ratelimit*, the spam check runs regardless |
| `user_may_invite` | no | `handlers/room_member.py:906` |
| `user_may_send_3pid_invite` | no | `handlers/room_member.py:1734` |
| `user_may_create_room_alias` | no | `handlers/directory.py:155` |
| `user_may_publish_room` | no | `handlers/directory.py:449` |

So making your platform's bot a server admin is **not** enough. Without an
`exempt` rule, your own automation stops working the moment you enable this
module. That is why `exempt` comes first in this README.

```yaml
modules:
  - module: synapse_managed_rooms.ManagedRoomsModule
    config:
      exempt:
        - match: "@service-[a-z0-9]+:chat\\.example\\.org"
          allow: [create_room, invite, 3pid_invite, join_room, create_room_alias, publish_room]
```

Patterns are matched with `re.fullmatch` against the complete Matrix ID.

**Always spell out the server name.** `@service-.*:.*` looks convenient and is an
own goal: with federation enabled, any remote server can create an account with a
matching localpart and inherit your exemption. The module refuses to start on
such a pattern.

---

## 2. Threat model — what this does not cover

Be honest about this before you rely on it.

- **Compromised admin accounts.** An admin bypasses `join_room` by design and can
  disable the module in the config. Access control for administrators remains
  your job.
- **Application services.** Bridges and AS-registered bots run past parts of these
  checks. If you run none, you are unaffected; if you do, review them separately.
- **Existing rooms.** The module prevents new side doors. It does not clean up
  what is already there. Take inventory before enabling it.
- **Power levels in direct messages.** Clients typically create DMs with
  `preset: trusted_private_chat`, which puts **both** participants at power level
  100. If you rely on power levels to stop invitations, that does not hold in DM
  rooms — the boundary there is this module's rule (§3.2), not the power level. If
  you control the client, set `power_level_content_override` when creating DMs;
  the module deliberately does not depend on you doing so.
- **This is not a moderation tool.** It says who may create and invite, not what
  anyone may say.

---

## 3. Configuration

### 3.1 The six doors

```yaml
modules:
  - module: synapse_managed_rooms.ManagedRoomsModule
    config:
      # Optional. If omitted, ALL SIX actions are denied.
      # Anyone enabling a module called "managed rooms" wants the closed door —
      # not one you can forget to close.
      deny:
        - create_room
        - invite
        - 3pid_invite
        - join_room
        - create_room_alias
        - publish_room

      exempt:
        - match: "@service-[a-z0-9]+:chat\\.example\\.org"
          allow: [create_room, invite, 3pid_invite, join_room, create_room_alias, publish_room]
        # Example: a federated partner may join, nothing else.
        # - match: "@[a-z0-9._=/-]+:partner\\.example"
        #   allow: [join_room]

      # Optional, default false. See 3.2.
      allow_direct_messages: false

      # Optional, default TRUE. See 3.3 - read it before turning this off.
      allow_invited_joins: true
```

Rules are evaluated top to bottom; **the first match wins** and no later rule is
considered. Anything not matched by any rule is denied.

**Configuration errors stop Synapse from starting.** Unknown keys, unknown action
names, invalid patterns and open server names all raise. A security configuration
that swallows typos is not one.

### 3.2 `allow_direct_messages`

Most deployments want the same thing: *users may talk to each other one-to-one,
but may not create their own groups.* That is what this option is for.

It is not a single switch, because Synapse asks twice. `POST /createRoom` with an
`invite` list runs `user_may_create_room` **and then** `user_may_invite` for each
invitee — the invite check is *not* skipped for freshly created rooms
(`handlers/room.py:1342-1356` → `handlers/room_member.py:903-921`; the `new_room`
exemption exists for joins, not for invites).

Opening only the create side would produce a room whose invitation fails one line
later: a direct chat where nobody ever arrives. Worse than a clean refusal. So the
option covers both halves.

**On create**, the request must look like a real one-to-one chat:

- `is_direct` is set, and exactly **one** Matrix ID is invited
- no `name`, no `room_alias_name`, not `public`
- `preset` is `private_chat` or `trusted_private_chat`
- `creation_content` carries nothing but `m.federate` (in particular no `type` —
  that would make it a space)
- `initial_state` is checked **event by event** against an allow-list
  (`m.room.encryption`, a non-`world_readable` `m.room.history_visibility`,
  `m.room.guest_access: forbidden`). Without this, a name or
  `join_rules: public` simply moves one level down and walks past a top-level check.

**On invite**, Synapse hands the callback only `(inviter, invitee, room_id)` — no
config, no `is_direct`. So the module reads the room state and requires all of:

1. `m.room.create` was sent by the inviter, and the room is not a space
2. no `m.room.name`, no `m.room.canonical_alias`
3. `join_rule == invite`
4. the number of members with membership **`join` or `invite`** is exactly **1** —
   the inviter themselves

**Condition 4 is the wall, and it only stands because `invite` is counted.** If you
counted joined members only: A creates the room and invites B — still only A has
joined. While B has not accepted, A invites C, D and E, each passing the same
check, and a five-person group has been built entirely through the DM exception.
Counting `join + invite` makes the exception **once per room**.

Because `leave` appears in neither count, one case falls out for free: if the
other person leaves, the count drops back to 1 and they can be re-invited.

**Failures mean refusal.** If the room state cannot be read, the invite is denied.

### 3.3 Joining: the invitation is the decision

`user_may_join_room` fires when someone **accepts an invitation**, not only when
they walk into a public room. And it fires with the *invited user* as the
requester even when a server admin issued the join through
`/_synapse/admin/v1/join` — that endpoint joins with a requester faked to be the
target user (`rest/admin/rooms.py`), so the built-in admin exemption from §1 does
**not** apply there.

Denying `join_room` outright therefore breaks two things at once: anyone
accepting an invitation, and your leading system placing its own users into
rooms through the admin API. That is not a hypothetical — it is the most common
operation such a system performs.

So `allow_invited_joins` defaults to **true**. This gives nothing away: the
invitation is the decision, and invitations are gated by this same module. What
stays shut is the join *without* an invitation — public rooms, knocking, room
directory browsing.

Turn it off only if you gate invitations somewhere else entirely and know what
you are giving up. The module logs a warning at startup if you do.

### 3.4 Concurrency

Condition 4 reads room state and then decides — the classic place for a race. In
practice Synapse serialises it: `update_membership` takes a linearizer keyed by
`(room_id,)` and calls `update_membership_locked`, which contains the
`user_may_invite` call (`handlers/room_member.py:660-680`). Two concurrent invites
to the same room queue behind each other on the same process.

Caveat worth knowing: that linearizer is **per process**. On a multi-worker
deployment where membership events for one room can be handled by different
workers, a narrow race window remains. If that matters to you, create direct
rooms from your leading system instead of enabling this option.

---

## 4. Error messages are not ours to choose

Synapse replies to a rejected request with a fixed body:

```json
{"errcode": "M_FORBIDDEN", "error": "You are not permitted to create rooms"}
```

The module returns `Codes.FORBIDDEN`; the human-readable text is Synapse's, and
callbacks cannot replace it. (For invites, Synapse allows a module to attach
extra JSON fields, but the `error` string stays fixed.)

If you run your own client, catch `M_FORBIDDEN` on these endpoints and show your
own sentence — *"Rooms are created in <your platform>."* Users of vanilla Element
will see the generic text. That is a deliberate, documented limitation, not a bug.

---

## 5. Installation

```
pip install synapse-managed-rooms
```

Then add the `modules:` block from §3 to your `homeserver.yaml` and restart
Synapse. Watch the log for the startup line:

```
[managed-rooms] active - denied: ... | exemptions: N | direct messages: ...
```

Warnings (no exemption configured, exception with nothing to do) are logged at
`WARNING` on startup.

---

## 6. Maintenance

Maintained by [Prilog](https://prilog.chat), which runs it in production.

- **Synapse releases** are checked against this module through our release watch;
  the CI matrix additionally builds against Synapse `develop` as an early warning
  for interface drift.
- **Interface changes** are what killed the predecessor
  (`matrix-org/synapse-user-restrictions`, unmaintained since 2021, never
  published to PyPI, returns booleans a modern Synapse no longer accepts). The
  integration tests in `tests/integration/` exist specifically to catch that.
- **If maintenance ends**, the repository will be archived with a note saying so,
  rather than quietly rotting.

Security reports: see [SECURITY.md](SECURITY.md). Contributions:
[CONTRIBUTING.md](CONTRIBUTING.md).

## 7. Licence

Apache-2.0. Synapse itself is AGPLv3 since Element took stewardship; this module
is distributed independently, Apache-2.0 is compatible with AGPL environments, and
it lowers the barrier for other operators to adopt it. If you ship the module
*together with* Synapse, the AGPL applies to that combined work — that is the
operator's concern, not the module's.

---

Deutsche Fassung: [README.de.md](README.de.md) · Konzept und Begründungen:
[prilog_docs/umsetzung/synapse-modul](https://github.com/brasilspace/prilog_docs/blob/main/umsetzung/synapse-modul/synapse-managed-homeserver-konzept.md)
