"""Thread-safe local HTTP boundary for the browser game UI.

Only JSON-safe values cross this module's HTTP boundary.  A browser receives
the observation already filtered by :mod:`fireplace.observation` and the
canonical dictionaries returned by :class:`fireplace.agent_api.Action`.
Fireplace entities are kept inside ``GameSession`` and are never serialized or
looked up by the request handler.
"""

from __future__ import annotations

import copy
import ipaddress
import json
import threading
import uuid
from collections.abc import Mapping
from concurrent.futures import TimeoutError as FutureTimeout
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from ..agent_api import Action
from ..controller import ActionError, GameSession, decision_player
from ..exceptions import GameOver
from .assets import AssetService

try:  # Optional parallel asset package.  The UI works without it.
    from card_assets import AssetResolver as _AssetResolver
except Exception:  # pragma: no cover - import depends on an optional package
    _AssetResolver = None


_ASSET_KINDS = frozenset({"render", "art", "tile"})
_LOCALES = frozenset({"zhCN", "enUS"})
_OPPONENTS = frozenset({"random", "heuristic"})
_ASSET_PENDING = object()
_JSON_ERROR = object()
_STATIC_MIME_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "action_model.js": "text/javascript; charset=utf-8",
    "i18n.js": "text/javascript; charset=utf-8",
    "status_view.js": "text/javascript; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
    "board-scene.webp": "image/webp",
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


def _outcome(game: object, human: object) -> dict[str, str | bool | None] | None:
    """Return the deliberately small terminal result projection."""

    if not _game_ended(game):
        return None

    winner = None
    human_won = False
    for player in getattr(game, "players", ()):
        state = getattr(player, "playstate", None)
        state_name = getattr(state, "name", state)
        if str(state_name).upper() == "WON":
            winner = _player_name(player)
            human_won = player is human
            break
    return {"winner": winner, "human_won": human_won if winner else None}


def _description_value(description: object, name: str) -> Any:
    value = _field(description, name)
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _decorate_visible_cards(value: object, descriptions: Mapping[str, object]) -> None:
    """Enrich visible observation card mappings with optional card text.

    ``Observation`` has already removed hidden opponent card identities.  This
    walk therefore only sees fields that are safe to expose to the human
    player.  It never follows or serializes a Fireplace object.
    """

    if isinstance(value, dict):
        card_id = value.get("card_id")
        if isinstance(card_id, str) and card_id:
            description = descriptions.get(card_id)
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
            _decorate_visible_cards(child, descriptions)
    elif isinstance(value, list):
        for child in value:
            _decorate_visible_cards(child, descriptions)


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


def _visible_entity_details(
    observation: Mapping[str, Any],
) -> dict[int, dict[str, str]]:
    """Index safe names and card IDs visible to this viewer.

    Event text must never be derived from the opponent's private action log or
    from engine entities.  In particular an opponent's hand card is absent
    from this observation until the engine exposes it publicly.
    """

    result: dict[int, dict[str, str]] = {}

    def visit(item: object) -> None:
        if isinstance(item, Mapping):
            entity_id = item.get("entity_id")
            name = item.get("name")
            if type(entity_id) is int and isinstance(name, str) and name:
                detail = {"name": name}
                card_id = item.get("card_id")
                if isinstance(card_id, str) and card_id:
                    detail["card_id"] = card_id
                result[entity_id] = detail
            for child in item.values():
                visit(child)
        elif isinstance(item, (list, tuple)):
            for child in item:
                visit(child)

    visit(observation)
    return result


def _visible_entity_names(observation: Mapping[str, Any]) -> dict[int, str]:
    """Index names that this viewer could see before a decision."""

    return {
        entity_id: detail["name"]
        for entity_id, detail in _visible_entity_details(observation).items()
    }


class WebActionError(ValueError):
    """An HTTP action failure with its current, privacy-filtered snapshot."""

    def __init__(self, message: str, status_code: int, snapshot: dict[str, Any]):
        super().__init__(message)
        self.status_code = int(status_code)
        self.snapshot = snapshot


class WebLifecycleError(ValueError):
    """An HTTP failure while changing between lobby and match modes."""

    def __init__(self, message: str, status_code: int, snapshot: dict[str, Any]):
        super().__init__(message)
        self.status_code = int(status_code)
        self.snapshot = snapshot


def _validate_locale(value: object) -> str:
    if value not in _LOCALES:
        raise ValueError("locale must be 'zhCN' or 'enUS'")
    return str(value)


def _validate_opponent(value: object) -> str:
    if value not in _OPPONENTS:
        raise ValueError("opponent must be 'random' or 'heuristic'")
    return str(value)


def _validate_nickname(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("nickname must be a string")
    nickname = value.strip()
    if not nickname:
        raise ValueError("nickname must not be empty")
    if len(nickname) > 32:
        raise ValueError("nickname must be at most 32 characters")
    return nickname


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
        locale: str = "zhCN",
    ) -> None:
        self.locale = _validate_locale(locale)
        self.session = session
        self.human = human
        self.opponent_agent = opponent_agent
        self._lock = threading.RLock()
        self._revision = 0
        self._session_id = str(uuid.uuid4())
        self._started = False
        self._events: list[dict[str, Any]] = []
        self._event_seq = 0
        self.asset_resolver = (
            asset_resolver if asset_resolver is not None else self._load_resolver()
        )
        self.assets = AssetService(resolver=self.asset_resolver)
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

    def close(self, *, wait: bool = True) -> None:
        """Release optional asset workers when the local server closes."""

        self.assets.close(wait=wait)

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

    def _localized_observation_locked(self, observation: object) -> object:
        """Decorate one already filtered observation in the match locale."""

        localized = copy.deepcopy(observation)
        visible_ids = _visible_card_ids(localized)
        descriptions = self.assets.describe_visible(visible_ids, locale=self.locale)
        if descriptions:
            _decorate_visible_cards(localized, descriptions)
        return localized

    def _public_events_locked(self) -> list[dict[str, Any]]:
        """Return event rows without internal localization metadata.

        The private card IDs are captured only from filtered observations at
        the moment an entity is visible.  They let a later snapshot replace a
        temporary fallback name after an asynchronous asset description has
        completed, while the browser never receives those internal fields.
        """

        events = copy.deepcopy(self._events)
        card_ids = {
            card_id
            for event in events
            for key in ("_source_card_id", "_target_card_id")
            if isinstance(card_id := event.get(key), str) and card_id
        }
        if card_ids:
            descriptions = self.assets.describe_visible(card_ids, locale=self.locale)
        else:
            descriptions = {}

        for event in events:
            source_card_id = event.pop("_source_card_id", None)
            target_card_id = event.pop("_target_card_id", None)
            if source_card_id in descriptions:
                name = _description_value(descriptions[source_card_id], "name")
                if name:
                    event["source_name"] = str(name)
            if target_card_id in descriptions:
                name = _description_value(descriptions[target_card_id], "name")
                if name:
                    event["target_name"] = str(name)
        return events

    def _snapshot_locked(self) -> dict[str, Any]:
        observation = self._localized_observation_locked(
            self.session.observation(self.human)
        )

        _decision, actions = self._decision_actions_locked()
        return {
            "mode": "match",
            "session_id": self._session_id,
            "revision": self._revision,
            "locale": self.locale,
            "nickname": _player_name(self.human),
            "observation": observation,
            "legal_actions": [action.to_dict() for action in actions],
            "outcome": _outcome(self.session.game, self.human),
            "events": self._public_events_locked(),
        }

    def _public_event_locked(
        self, player: object, action: Action, observation: Mapping[str, Any]
    ) -> dict[str, Any]:
        """Project an accepted action into a small, privacy-filtered log row."""

        observation = self._localized_observation_locked(observation)
        actor = "self" if player is self.human else "opponent"
        details = _visible_entity_details(observation)
        names = {entity_id: detail["name"] for entity_id, detail in details.items()}
        event: dict[str, Any] = {
            "seq": self._event_seq + 1,
            "turn": observation.get("turn"),
            "actor": actor,
            "type": action.type,
        }
        # A card in the opponent's hand and a pending opponent choice are
        # private.  Only a human-owned card, or an already public attacker or
        # hero power, may have its source name shown here.
        if actor == "self" or action.type in ("ATTACK", "USE_HERO_POWER"):
            source = names.get(action.source_entity_id)
            if source:
                event["source_name"] = source
                event["source_entity_id"] = action.source_entity_id
                source_card_id = details[action.source_entity_id].get("card_id")
                if source_card_id:
                    event["_source_card_id"] = source_card_id
        if action.type in ("PLAY_CARD", "ATTACK", "USE_HERO_POWER"):
            target = names.get(action.target_entity_id)
            if target:
                event["target_name"] = target
                event["target_entity_id"] = action.target_entity_id
                target_card_id = details[action.target_entity_id].get("card_id")
                if target_card_id:
                    event["_target_card_id"] = target_card_id
        if actor == "self" and action.type == "PLAY_CARD" and action.position is not None:
            event["position"] = action.position
        if actor == "self" and action.type == "CHOOSE":
            choice = names.get(action.choice_entity_id)
            if choice:
                event["source_name"] = choice
                choice_card_id = details[action.choice_entity_id].get("card_id")
                if choice_card_id:
                    event["_source_card_id"] = choice_card_id
        return event

    def _append_event_locked(self, event: dict[str, Any]) -> None:
        self._event_seq += 1
        self._events.append(event)

    def _reveal_played_public_card_locked(
        self, event: dict[str, Any], action: Action
    ) -> None:
        """Name an opponent play only if that entity became publicly visible."""

        if event["actor"] != "opponent" or action.type != "PLAY_CARD":
            return
        observation = self._localized_observation_locked(
            self.session.observation(self.human)
        )
        details = _visible_entity_details(observation)
        detail = details.get(action.source_entity_id)
        if detail:
            event["source_name"] = detail["name"]
            event["source_entity_id"] = action.source_entity_id
            card_id = detail.get("card_id")
            if card_id:
                event["_source_card_id"] = card_id

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
            event = self._public_event_locked(
                player, action, self.session.observation(self.human)
            )
            try:
                self.session.execute(player, action)
            except GameOver:
                self._reveal_played_public_card_locked(event, action)
                self._append_event_locked(event)
                self._revision += 1
                return
            except ActionError as exc:
                raise RuntimeError("Opponent action was rejected: %s" % exc) from exc
            self._reveal_played_public_card_locked(event, action)
            self._append_event_locked(event)
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

            if payload.get("session_id") != self._session_id:
                current["error"] = "stale session"
                raise WebActionError(current["error"], 409, current)

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

            event = self._public_event_locked(
                self.human, action, current["observation"]
            )
            try:
                self.session.execute(self.human, action)
            except GameOver:
                # GameSession has already applied and logged the accepted
                # action before raising its terminal signal.
                self._append_event_locked(event)
                self._revision += 1
                return self._snapshot_locked()
            except ActionError as exc:
                current = self._snapshot_locked()
                current["error"] = str(exc)
                raise WebActionError(str(exc), 409, current) from exc

            self._append_event_locked(event)
            self._revision += 1
            self._advance_ai_locked()
            return self._snapshot_locked()

    def asset(self, kind: str, card_id: str) -> tuple[bytes, str, bool] | object | None:
        """Resolve one visible card asset to bytes and a content type.

        Unknown card ids, unsupported kinds, unavailable resolvers and resolver
        errors all return ``None``.  This is deliberately a local allowlist
        derived from the current observation, so hidden opponent cards cannot
        be probed through this route.
        """

        if kind not in _ASSET_KINDS or not isinstance(card_id, str):
            return None
        with self._lock:
            if card_id not in _visible_card_ids(self.session.observation(self.human)):
                return None
        # A cache miss may download an image for up to two locale timeouts.
        # Respond immediately so image requests cannot monopolize the
        # browser's per-origin connections and delay player actions.
        future = self.assets.request_asset(card_id, kind, locale=self.locale)
        try:
            asset = future.result(timeout=0.05)
        except FutureTimeout:
            return _ASSET_PENDING
        except Exception:
            return None
        if asset is None:
            return None
        return asset.data, asset.media_type, asset.is_placeholder


class WebGameManager:
    """Own the lobby and at most one active :class:`WebGame`.

    ``WebGame`` remains the single-match decision boundary.  This manager only
    constructs a fresh match from lobby input and discards it after a terminal
    result has been returned to the lobby.  Keeping that lifecycle here avoids
    adding lobby branches to action validation and execution.
    """

    def __init__(
        self,
        *,
        seed: int | None = None,
        opponent: str = "random",
        asset_resolver: object | None = None,
    ) -> None:
        if seed is not None and type(seed) is not int:
            raise ValueError("seed must be an integer or None")
        self._base_seed = seed
        self._opponent_default = _validate_opponent(opponent)
        self._asset_resolver = asset_resolver
        self._match_count = 0
        self._active: WebGame | None = None
        self._lock = threading.RLock()

    @property
    def active(self) -> WebGame | None:
        """Return the current match for internal server adapters."""

        with self._lock:
            return self._active

    @property
    def opponent_default(self) -> str:
        return self._opponent_default

    def _lobby_snapshot_locked(self) -> dict[str, Any]:
        return {
            "mode": "lobby",
            "opponent": self._opponent_default,
        }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            active = self._active
            if active is None:
                return self._lobby_snapshot_locked()
            return active.snapshot()

    def error_payload(self, message: str) -> dict[str, Any]:
        with self._lock:
            active = self._active
            payload = (
                active.error_payload(message)
                if active is not None
                else self._lobby_snapshot_locked()
            )
            if active is None:
                payload["error"] = str(message)
            return payload

    def _next_seed_locked(self) -> int | None:
        if self._base_seed is None:
            return None
        return self._base_seed + self._match_count

    def start_match(self, payload: object) -> dict[str, Any]:
        """Create a fresh random-class/random-deck match from lobby input."""

        with self._lock:
            current = (
                self._active.snapshot()
                if self._active is not None
                else self._lobby_snapshot_locked()
            )
            if self._active is not None:
                raise WebLifecycleError(
                    "return to the lobby before starting another match", 409, current
                )
            if not isinstance(payload, Mapping):
                raise WebLifecycleError("request body must be a JSON object", 400, current)
            try:
                nickname = _validate_nickname(payload.get("nickname"))
                opponent = _validate_opponent(payload.get("opponent"))
                locale = _validate_locale(payload.get("locale"))
            except ValueError as exc:
                raise WebLifecycleError(str(exc), 400, current) from exc

            # Imports stay local so direct single-match users do not pay for
            # the lobby factory until they actually request a new match.
            from fireplace.agents import HeuristicAgent, RandomAgent
            from fireplace.controller import GameSession
            from .factory import build_game

            match_seed = self._next_seed_locked()
            opponent_name = "Heuristic" if opponent == "heuristic" else "Random"
            game, human, _opponent = build_game(
                match_seed, opponent_name, nickname=nickname
            )
            opponent_agent = (
                HeuristicAgent()
                if opponent == "heuristic"
                else RandomAgent(seed=match_seed)
            )
            active = WebGame(
                GameSession(game, {}),
                human,
                opponent_agent,
                asset_resolver=self._asset_resolver,
                locale=locale,
            )
            self._active = active
            self._match_count += 1
            return active.snapshot()

    def return_to_lobby(self, payload: object) -> dict[str, Any]:
        """Close a terminal match after validating its current revision."""

        with self._lock:
            active = self._active
            if active is None:
                current = self._lobby_snapshot_locked()
                raise WebLifecycleError("no active match", 409, current)
            current = active.snapshot()
            if not isinstance(payload, Mapping):
                raise WebLifecycleError("request body must be a JSON object", 400, current)
            if payload.get("session_id") != current["session_id"]:
                raise WebLifecycleError("stale session", 409, current)
            revision = payload.get("revision")
            if type(revision) is not int:
                raise WebLifecycleError("revision must be an integer", 400, current)
            if revision != current["revision"]:
                raise WebLifecycleError("stale revision", 409, current)
            if current.get("outcome") is None:
                raise WebLifecycleError("match is not over", 409, current)

            self._active = None
            lobby = self._lobby_snapshot_locked()

        # A resolver may still be downloading an uncached image.  Detach the
        # match first so state and a new start remain responsive, then cancel
        # pending asset work without waiting for an already-running resolver.
        active.close(wait=False)
        return lobby

    def handle_action(self, payload: object) -> dict[str, Any]:
        with self._lock:
            active = self._active
            if active is None:
                raise WebActionError("no active match", 409, self._lobby_snapshot_locked())
            return active.handle_action(payload)

    def asset(self, kind: str, card_id: str) -> tuple[bytes, str, bool] | object | None:
        with self._lock:
            active = self._active
            if active is None:
                return None
            return active.asset(kind, card_id)

    def close(self) -> None:
        with self._lock:
            active = self._active
            self._active = None
        if active is not None:
            active.close(wait=True)


class WebGameHTTPServer(ThreadingHTTPServer):
    """HTTP server carrying a single game or lobby manager instance."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        web_game: WebGame | WebGameManager,
    ):
        if server_address[0] not in {"127.0.0.1", "localhost"}:
            raise ValueError("web GUI must bind to loopback")
        self.web_game = web_game
        super().__init__(server_address, _RequestHandler)

    def server_close(self) -> None:
        super().server_close()
        self.web_game.close()


def _json_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class _RequestHandler(BaseHTTPRequestHandler):
    """Small HTTP adapter kept free of engine imports and object traversal."""

    server_version = "FireplaceWeb/1.0"

    @property
    def web_game(self) -> WebGame:
        return self.server.web_game  # type: ignore[attr-defined]

    def _send_bytes(
        self, status: int, data: bytes, content_type: str,
        *, placeholder: bool | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if placeholder is not None:
            self.send_header("X-Asset-Placeholder", "1" if placeholder else "0")
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

    def _local_host(self) -> str | None:
        """Reject DNS rebinding names before serving private game state."""

        host = self.headers.get("Host", "").lower()
        port = self.server.server_port
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if port == 80:
            allowed.update({"127.0.0.1", "localhost"})
        return host if host in allowed else None

    def _reject_untrusted_request(self) -> bool:
        try:
            local_peer = ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            local_peer = False
        if local_peer and self._local_host() is not None:
            return False
        self._send_json(int(HTTPStatus.FORBIDDEN), {"error": "local host required"})
        return True

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if self._reject_untrusted_request():
            return
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == "/api/state":
            self._send_json(int(HTTPStatus.OK), self.web_game.snapshot())
            return
        if path == "/":
            self._serve_static("index.html")
            return
        if path in {
            "/app.js",
            "/action_model.js",
            "/i18n.js",
            "/status_view.js",
            "/style.css",
            "/board-scene.webp",
        }:
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
                    if asset is _ASSET_PENDING:
                        self._send_bytes(
                            int(HTTPStatus.ACCEPTED), b"", "application/octet-stream"
                        )
                        return
                    if asset is not None:
                        self._send_bytes(
                            int(HTTPStatus.OK), asset[0], asset[1],
                            placeholder=asset[2],
                        )
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

    def _check_origin(self) -> bool:
        origin = self.headers.get("Origin")
        local_host = self._local_host()
        if origin is not None and origin != "http://" + str(local_host):
            self._send_json(
                int(HTTPStatus.FORBIDDEN),
                self.web_game.error_payload("cross-origin request rejected"),
            )
            return False
        return True

    def _read_json(self) -> object:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._send_json(
                int(HTTPStatus.UNSUPPORTED_MEDIA_TYPE),
                self.web_game.error_payload("JSON content type required"),
            )
            return _JSON_ERROR
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
            return _JSON_ERROR
        try:
            body = self.rfile.read(length)
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._send_json(
                int(HTTPStatus.BAD_REQUEST),
                self.web_game.error_payload("request body must be valid JSON"),
            )
            return _JSON_ERROR

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if self._reject_untrusted_request():
            return
        path = urlsplit(self.path).path
        if path not in {"/api/action", "/api/start", "/api/return"}:
            self._not_found()
            return
        if not self._check_origin():
            return
        payload = self._read_json()
        if payload is _JSON_ERROR:
            return
        try:
            if path == "/api/action":
                response = self.web_game.handle_action(payload)
            elif path == "/api/start":
                start_match = getattr(self.web_game, "start_match", None)
                if start_match is None:
                    raise WebLifecycleError(
                        "match lifecycle is unavailable for this server", 409,
                        self.web_game.snapshot(),
                    )
                response = start_match(payload)
            else:
                return_to_lobby = getattr(self.web_game, "return_to_lobby", None)
                if return_to_lobby is None:
                    raise WebLifecycleError(
                        "match lifecycle is unavailable for this server", 409,
                        self.web_game.snapshot(),
                    )
                response = return_to_lobby(payload)
        except (WebActionError, WebLifecycleError) as exc:
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
    web_game: WebGame | WebGameManager | None = None,
    host: str = "127.0.0.1",
    port: int = 8000,
    *,
    seed: int | None = None,
    opponent: str = "random",
) -> WebGameHTTPServer:
    """Create a local threaded HTTP server for a game or a fresh lobby."""

    if web_game is None:
        web_game = WebGameManager(seed=seed, opponent=opponent)

    return WebGameHTTPServer((host, int(port)), web_game)


create_server = make_server


def serve(
    web_game: WebGame | WebGameManager | None = None,
    host: str = "127.0.0.1",
    port: int = 8000,
    *,
    seed: int | None = None,
    opponent: str = "random",
) -> None:
    """Run a server until interrupted, closing its listening socket."""

    server = make_server(
        web_game, host=host, port=port, seed=seed, opponent=opponent
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()


__all__ = [
    "WebActionError",
    "WebLifecycleError",
    "WebGame",
    "WebGameManager",
    "WebGameHTTPServer",
    "create_server",
    "make_server",
    "serve",
]
