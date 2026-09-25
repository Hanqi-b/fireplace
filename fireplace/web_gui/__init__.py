"""Local browser UI support for a single Fireplace game.

The browser-facing API is intentionally small.  :class:`WebGame` owns a
``GameSession`` and projects it to JSON-safe values, while :func:`make_server`
adapts that object to a standard-library HTTP server.
"""

from .server import (
    WebActionError,
    WebGame,
    WebGameHTTPServer,
    create_server,
    make_server,
    serve,
)

__all__ = [
    "WebActionError",
    "WebGame",
    "WebGameHTTPServer",
    "create_server",
    "make_server",
    "serve",
]
