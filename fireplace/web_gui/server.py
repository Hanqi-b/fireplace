"""Thread-safe local HTTP boundary for the browser game UI.

Only JSON-safe values cross this module's HTTP boundary.  A browser receives
the observation already filtered by :mod:`fireplace.observation` and the
canonical dictionaries returned by :class:`fireplace.agent_api.Action`.
Fireplace entities are kept inside ``GameSession`` and are never serialized or
looked up by the request handler.
"""

from __future__ import annotations

import copy
import json
import mimetypes
import threading
from collections.abc import Mapping
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from ..agent_api import Action
from ..controller import ActionError, GameSession, decision_player
from ..exceptions import GameOver

try:  # Optional parallel asset package.  The UI works without it.
    from card_assets import AssetResolver as _AssetResolver
except Exception:  # pragma: no cover - import depends on an optional package
    _AssetResolver = None


_ASSET_KINDS = frozenset({"render", "art", "tile"})
_STATIC_MIME_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
}
_MAX_REQUEST_BYTES = 1 << 20


def _field(value: object, name: str, default: Any = None) -> Any:
    """Read a scalar field from a mapping or a small asset value object."""

    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _game_ended(game: object) -> bool:
    value = getattr(game, "ended", False)
    if callable(value):
        try:
            value = value()
        except Exception:
            return False
    return bool(value)


def _player_name(player: object) -> str | None:
    value = getattr(player, "name", None)
    if value is None:
        return None
    return str(value)


def _outcome(game: object) -> dict[str, str | None] | None:
    """Return the deliberately small terminal result projection."""

    if not _game_ended(game):
        return None

    winner = None
    for player in getattr(game, "players", ()):
        state = getattr(player, "playstate", None)
        state_name = getattr(state, "name", state)
        if str(state_name).upper() == "WON":
            winner = _player_name(player)
            break
    return {"winner": winner}


def _description_value(description: object, name: str) -> Any:
    value = _field(description, name)
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _decorate_visible_cards(value: object, resolver: object) -> None:
    """Enrich visible observation card mappings with optional card text.

    ``Observation`` has already removed hidden opponent card identities.  This
    walk therefore only sees fields that are safe to expose to the human
    player.  It never follows or serializes a Fireplace object.
    """

    if isinstance(value, dict):
        card_id = value.get("card_id")
        if isinstance(card_id, str) and card_id:
            try:
                description = resolver.describe(card_id)
            except Exception:
                description = None
            if description is not None:
                name = _description_value(description, "name")
                text = _description_value(description, "text")
                locale = _description_value(description, "locale")
                if name:
                    value["name"] = str(name)
                if text is not None:
                    value["text"] = str(text)
                if locale:
                    value["locale"] = str(locale)
        for child in value.values():
            _decorate_visible_cards(child, resolver)
    elif isinstance(value, list):
        for child in value:
            _decorate_visible_cards(child, resolver)


def _visible_card_ids(value: object) -> set[str]:
    """Collect card ids from a filtered observation, never from the game."""

    result: set[str] = set()

    def visit(item: object) -> None:
        if isinstance(item, Mapping):
            card_id = item.get("card_id")
            if isinstance(card_id, str) and card_id:
                result.add(card_id)
            for child in item.values():
                visit(child)
        elif isinstance(item, (list, tuple)):
            for child in item:
                visit(child)

    visit(value)
    return result


class WebActionError(ValueError):
    """An HTTP action failure with its current, privacy-filtered snapshot."""

    def __init__(self, message: str, status_code: int, snapshot: dict[str, Any]):
        super().__init__(message)
        self.status_code = int(status_code)
        self.snapshot = snapshot


class WebGame:
    """Own one local human-vs-agent ``GameSession``.

    Construction starts the session and lets the opponent make decisions until
    the supplied ``human`` is the next decision player or the game ends.  The
    public methods are safe to call from multiple HTTP worker threads.
    """

    def __init__(
        self,
        session: GameSession,
        human: object,
        opponent_agent: object,
        *,
        asset_resolver: object | None = None,
    ) -> None:
        self.session = session
        self.human = human
        self.opponent_agent = opponent_agent
        self._lock = threading.RLock()
        self._revision = 0
        self._started = False
        self.asset_resolver = (
            asset_resolver if asset_resolver is not None else self._load_resolver()
        )
        self.start()

    @staticmethod
    def _load_resolver() -> object | None:
        if _AssetResolver is None:
            return None
        try:
            return _AssetResolver(cache_dir=None)
        except Exception:
            return None

    @property
    def lock(self) -> threading.RLock:
        """Expose the lock to the HTTP adapter without exposing game state."""

        return self._lock

    @property
    def revision(self) -> int:
        with self._lock:
            return self._revision

    def start(self) -> dict[str, Any]:
        """Start the session once and advance the AI to the human decision."""

        with self._lock:
            if not self._started:
                self.session.start()
                self._started = True
                self._advance_ai_locked()
            return self._snapshot_locked()

    def _decision_actions_locked(self) -> tuple[object | None, list[Action]]:
        game = self.session.game
        if _game_ended(game):
            return None, []
        player = decision_player(game)
        if player is not self.human:
            return player, []
        return player, list(self.session.legal_actions(self.human))

    def _snapshot_locked(self) -> dict[str, Any]:
        observation = self.session.observation(self.human)
        # ``build_observation`` returns a fresh JSON-safe value.  Copying here
        # also keeps optional resolver enrichment isolated from a test double
        # that might reuse its mapping.
        observation = copy.deepcopy(observation)
        if self.asset_resolver is not None:
            _decorate_visible_cards(observation, self.asset_resolver)

        _decision, actions = self._decision_actions_locked()
        return {
            "revision": self._revision,
            "observation": observation,
            "legal_actions": [action.to_dict() for action in actions],
            "outcome": _outcome(self.session.game),
        }

    def snapshot(self) -> dict[str, Any]:
        """Return the current browser payload as ordinary JSON-safe values."""

        with self._lock:
            return self._snapshot_locked()

    def error_payload(self, message: str) -> dict[str, Any]:
        """Return an error plus the latest snapshot for an HTTP response."""

        with self._lock:
            payload = self._snapshot_locked()
            payload["error"] = str(message)
            return payload

    def _advance_ai_locked(self) -> None:
        """Run the supplied agent until human input or terminal state."""

        while not _game_ended(self.session.game):
            player = decision_player(self.session.game)
            if player is None or player is self.human:
                return
            actions = list(self.session.legal_actions(player))
            if not actions:
                raise RuntimeError("No legal decision for the opponent")
            observation = self.session.observation(player)
            action = self.opponent_agent.choose_action(observation, actions)
            if isinstance(action, Mapping):
                try:
                    action = Action.from_dict(action)
                except (TypeError, ValueError) as exc:
                    raise RuntimeError("Opponent returned an invalid action") from exc
            if not isinstance(action, Action) or action not in actions:
                raise RuntimeError("Opponent returned an unavailable action")
            try:
                self.session.execute(player, action)
            except GameOver:
                self._revision += 1
                return
            except ActionError as exc:
                raise RuntimeError("Opponent action was rejected: %s" % exc) from exc
            self._revision += 1

    def handle_action(self, payload: object) -> dict[str, Any]:
        """Validate and execute one browser action, returning a new snapshot.

        ``WebActionError`` carries status 400 for malformed JSON values and
        status 409 for an old revision or an action that is no longer legal.
        """

        with self._lock:
            current = self._snapshot_locked()
            if not isinstance(payload, Mapping):
                raise WebActionError("request body must be a JSON object", 400, current)

            revision = payload.get("revision")
            if type(revision) is not int:
                current["error"] = "revision must be an integer"
                raise WebActionError(current["error"], 400, current)
            if revision != self._revision:
                current["error"] = "stale revision"
                raise WebActionError(current["error"], 409, current)

            raw_action = payload.get("action")
            try:
                action = Action.from_dict(raw_action)
            except (TypeError, ValueError) as exc:
                current["error"] = str(exc)
                raise WebActionError(str(exc), 400, current) from exc

            player, actions = self._decision_actions_locked()
            if player is not self.human:
                current["error"] = "it is not the human player's turn"
                raise WebActionError(current["error"], 409, current)
            if action not in actions:
                current["error"] = "action is unavailable or stale"
                raise WebActionError(current["error"], 409, current)

            try:
                self.session.execute(self.human, action)
            except GameOver:
                # GameSession has already applied and logged the accepted
                # action before raising its terminal signal.
                self._revision += 1
                return self._snapshot_locked()
            except ActionError as exc:
                current = self._snapshot_locked()
                current["error"] = str(exc)
                raise WebActionError(str(exc), 409, current) from exc

            self._revision += 1
            self._advance_ai_locked()
            return self._snapshot_locked()

    def asset(self, kind: str, card_id: str) -> tuple[bytes, str] | None:
        """Resolve one visible card asset to bytes and a content type.

        Unknown card ids, unsupported kinds, unavailable resolvers and resolver
        errors all return ``None``.  This is deliberately a local allowlist
        derived from the current observation, so hidden opponent cards cannot
        be probed through this route.
        """

        if kind not in _ASSET_KINDS or not isinstance(card_id, str):
            return None
        with self._lock:
            if card_id not in _visible_card_ids(self._snapshot_locked()["observation"]):
                return None
            resolver = self.asset_resolver
            if resolver is None:
                return None
            try:
                resolved = resolver.resolve(card_id, kind=kind)
            except Exception:
                return None
            path_value = _field(resolved, "path")
            if not path_value:
                return None
            try:
                path = Path(path_value).expanduser().resolve()
                if not path.is_file():
                    return None
                data = path.read_bytes()
            except (OSError, RuntimeError, TypeError, ValueError):
                return None
            media_type = _field(resolved, "media_type")
            if not isinstance(media_type, str) or not media_type:
                media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            return data, media_type


class WebGameHTTPServer(ThreadingHTTPServer):
    """HTTP server carrying a single :class:`WebGame` instance."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address: tuple[str, int], web_game: WebGame):
        self.web_game = web_game
        super().__init__(server_address, _RequestHandler)


def _json_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class _RequestHandler(BaseHTTPRequestHandler):
    """Small HTTP adapter kept free of engine imports and object traversal."""

    server_version = "FireplaceWeb/1.0"

    @property
    def web_game(self) -> WebGame:
        return self.server.web_game  # type: ignore[attr-defined]

    def _send_bytes(self, status: int, data: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, status: int, payload: object) -> None:
        try:
            data = _json_bytes(payload)
        except (TypeError, ValueError):
            status = int(HTTPStatus.INTERNAL_SERVER_ERROR)
            data = _json_bytes({"error": "server produced a non-JSON response"})
        self._send_bytes(status, data, "application/json; charset=utf-8")

    def _not_found(self) -> None:
        self._send_json(int(HTTPStatus.NOT_FOUND), {"error": "not found"})

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == "/api/state":
            self._send_json(int(HTTPStatus.OK), self.web_game.snapshot())
            return
        if path == "/":
            self._serve_static("index.html")
            return
        if path in {"/app.js", "/style.css"}:
            self._serve_static(path[1:])
            return
        if path.startswith("/assets/"):
            parts = path.split("/")
            if len(parts) == 4:
                kind = unquote(parts[2])
                card_id = unquote(parts[3])
                # Card ids in the asset contract are a single URL segment.
                if "/" not in card_id and "\\" not in card_id:
                    asset = self.web_game.asset(kind, card_id)
                    if asset is not None:
                        self._send_bytes(int(HTTPStatus.OK), asset[0], asset[1])
                        return
            self._not_found()
            return
        self._not_found()

    def _serve_static(self, name: str) -> None:
        root = Path(__file__).resolve().parent
        path = root / name
        if name not in _STATIC_MIME_TYPES or not path.is_file():
            self._not_found()
            return
        try:
            data = path.read_bytes()
        except OSError:
            self._not_found()
            return
        self._send_bytes(int(HTTPStatus.OK), data, _STATIC_MIME_TYPES[name])

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if urlsplit(self.path).path != "/api/action":
            self._not_found()
            return
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length) if raw_length is not None else -1
        except (TypeError, ValueError):
            length = -1
        if length < 0 or length > _MAX_REQUEST_BYTES:
            self._send_json(
                int(HTTPStatus.BAD_REQUEST),
                self.web_game.error_payload("invalid request body length"),
            )
            return
        try:
            body = self.rfile.read(length)
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._send_json(
                int(HTTPStatus.BAD_REQUEST),
                self.web_game.error_payload("request body must be valid JSON"),
            )
            return
        try:
            response = self.web_game.handle_action(payload)
        except WebActionError as exc:
            response = dict(exc.snapshot)
            response["error"] = str(exc)
            self._send_json(exc.status_code, response)
            return
        self._send_json(int(HTTPStatus.OK), response)

    def log_message(self, format: str, *args: object) -> None:
        # Keep normal BaseHTTPRequestHandler access logging.  This method is a
        # narrow override so type checkers accept the object formatting.
        super().log_message(format, *args)


def make_server(
    web_game: WebGame,
    host: str = "127.0.0.1",
    port: int = 8000,
) -> WebGameHTTPServer:
    """Create a local threaded HTTP server for ``web_game``."""

    return WebGameHTTPServer((host, int(port)), web_game)


create_server = make_server


def serve(
    web_game: WebGame,
    host: str = "127.0.0.1",
    port: int = 8000,
) -> None:
    """Run a server until interrupted, closing its listening socket."""

    server = make_server(web_game, host=host, port=port)
    try:
        server.serve_forever()
    finally:
        server.server_close()


__all__ = [
    "WebActionError",
    "WebGame",
    "WebGameHTTPServer",
    "create_server",
    "make_server",
    "serve",
]
