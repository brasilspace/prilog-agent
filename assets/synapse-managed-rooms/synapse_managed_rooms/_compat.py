"""The seam between this module and Synapse.

In production the module runs inside Synapse and uses the real values. For
tests and static analysis it must also import without Synapse installed —
otherwise every contribution needs a full Synapse environment, and that is
exactly what stops people from writing tests.

The fallback mirrors the originals **exactly**: Synapse defines ``NOT_SPAM`` as
the literal ``"NOT_SPAM"``, not as a sentinel object of its own. A fallback more
elegant than reality would give us green tests and different behaviour in
production — the most expensive kind of test failure.

When the fallback is in use, ``SYNAPSE_AVAILABLE`` is ``False``; the integration
tests insist that it is ``True``.
"""

from __future__ import annotations

try:  # pragma: no cover - depends on the environment
    from synapse.module_api import NOT_SPAM
    from synapse.module_api.errors import Codes

    SYNAPSE_AVAILABLE = True
except ImportError:  # pragma: no cover - test environment without Synapse
    from enum import Enum

    NOT_SPAM = "NOT_SPAM"  # type: ignore[assignment]

    class Codes(str, Enum):  # type: ignore[no-redef]
        FORBIDDEN = "M_FORBIDDEN"

    SYNAPSE_AVAILABLE = False

__all__ = ["NOT_SPAM", "SYNAPSE_AVAILABLE", "Codes"]
