"""synapse-managed-rooms: rooms are created in the leading system, not beside it."""

from .config import ACTIONS, ConfigError, ManagedRoomsConfig, parse_config
from .module import ManagedRoomsModule

__version__ = "0.1.0"

__all__ = [
    "ACTIONS",
    "ConfigError",
    "ManagedRoomsConfig",
    "ManagedRoomsModule",
    "__version__",
    "parse_config",
]
