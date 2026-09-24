"""Compact, JSON-safe logs of player decisions.

The engine emits many internal actions while resolving one player decision.
``ActionLog`` records only the value action accepted at the agent boundary,
plus enough initial metadata to identify the game that produced the log.  It
deliberately keeps no references to a ``Game`` or any other engine object.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Mapping


SCHEMA_VERSION = 1
_MISSING = object()
_INITIAL_PLAYER_FIELDS = (
    "_start_hand_size",
    "max_hand_size",
    "max_resources",
    "max_deck_size",
    "cant_draw",
    "cant_fatigue",
)


def _utc_now() -> str:
    """Return a compact, unambiguous UTC timestamp for the log."""

    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def _json_safe(value: Any) -> Any:
    """Copy a small value tree into values accepted by :mod:`json`.

    Action implementations are expected to return JSON-safe dictionaries.
    This helper still normalizes enum, UUID, tuple, and mapping values so the
    log remains safe when a caller supplies a light test double.
    """

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Enum):
        return _json_safe(value.value)
    if isinstance(value, (uuid.UUID, Path)):
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    raise TypeError("action log contains a non-JSON value: %r" % (type(value),))


def _card_id(value: Any) -> str | None:
    """Return a card definition id from either an id string or a Card value."""

    if value is None:
        return None
    if isinstance(value, str):
        return value
    card_id = getattr(value, "id", _MISSING)
    if card_id is not _MISSING:
        return None if card_id is None else str(card_id)
    # The public constructor accepts strings or Card objects.  Converting a
    # scalar fallback keeps malformed test fixtures serializable without
    # retaining an engine object in the log.
    if isinstance(value, (int, float, bool)):
        return str(value)
    return str(value)


def _player_name(player: Any) -> str | None:
    name = getattr(player, "name", None)
    return None if name is None else str(name)


def _initial_player_settings(player: Any) -> dict[str, Any]:
    return {
        name: _json_safe(getattr(player, name))
        for name in _INITIAL_PLAYER_FIELDS
        if hasattr(player, name)
    }


def _hero_id(player: Any) -> str | None:
    hero = getattr(player, "hero", None)
    if hero is not None:
        return _card_id(hero)
    return _card_id(getattr(player, "starting_hero", None))


def _deck_values(player: Any) -> list[str | None]:
    """Read the configured deck order without changing the engine state."""

    deck = getattr(player, "starting_deck", _MISSING)
    if deck is _MISSING or deck is None:
        deck = getattr(player, "deck", ())
    try:
        return [_card_id(card) for card in deck]
    except TypeError:
        return []


def _state_value(playstate: Any) -> Any:
    """Normalize a PlayState (or a test double) to a JSON scalar."""

    if isinstance(playstate, Enum):
        return _json_safe(playstate.value)
    if playstate is None or isinstance(playstate, (str, int, float, bool)):
        return playstate
    return str(playstate)


def _state_is_won(playstate: Any) -> bool:
    if isinstance(playstate, Enum):
        name = getattr(playstate, "name", "")
        if name == "WON":
            return True
        playstate = playstate.value
    return playstate == 4 or playstate == "WON"


def _repository_metadata() -> tuple[str | None, bool | None]:
    """Return the current repository revision and dirty state when available."""

    repo_dir = Path(__file__).resolve().parent
    try:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_dir,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all"],
            cwd=repo_dir,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None, None
    return revision or None, bool(status.strip())


class ActionLog:
    """Record accepted agent actions and optionally persist them as JSON.

    The log schema is intentionally small and stable.  ``players`` contains
    the input deck order captured at construction.  Once the engine has
    started, ``started`` adds resolved hero/deck fields for configurations
    such as Whizbang and Zayle whose effective deck is chosen during setup.
    """

    schema_version = SCHEMA_VERSION

    def __init__(
        self,
        game: Any,
        *,
        mode: str = "unspecified",
        output_path: str | os.PathLike[str] | None = None,
        game_id: str | uuid.UUID | None = None,
        source_revision: str | None = None,
        seed: Any = None,
    ) -> None:
        self.output_path = Path(output_path) if output_path is not None else None
        self._actions: list[dict[str, Any]] = []
        self._players = self._snapshot_players(game)
        self._first_player_seat: int | None = None
        self._result: dict[str, Any] | None = None
        self._status = "in_progress"
        self._started_at = _utc_now()
        self._finished_at: str | None = None
        self._replay: dict[str, Any] | None = None

        if source_revision is None:
            repository_revision, source_dirty = _repository_metadata()
            self._source_revision = repository_revision
            self._source_dirty = source_dirty
        else:
            # An explicit revision is already sufficient metadata for callers
            # that run outside a checkout.  Avoid an unnecessary git probe in
            # that case; dirty state is unknown rather than inferred.
            self._source_revision = str(source_revision)
            self._source_dirty = None
        self._game_id = str(game_id) if game_id is not None else str(uuid.uuid4())
        self._mode = _json_safe(mode)
        if seed is None:
            seed = getattr(game, "seed", None)
        if isinstance(seed, (bytes, bytearray)):
            self._seed = {"type": "bytes", "hex": bytes(seed).hex()}
        else:
            self._seed = _json_safe(seed) if seed is not None else None

        self._save_if_configured()

    @staticmethod
    def _snapshot_players(game: Any) -> list[dict[str, Any]]:
        players = getattr(game, "players", ())
        snapshot = []
        for seat, player in enumerate(players):
            snapshot.append(
                {
                    "seat": seat,
                    "name": _player_name(player),
                    "hero_id": _hero_id(player),
                    "deck_card_ids": _deck_values(player),
                    "is_standard": bool(getattr(player, "is_standard", True)),
                    "initial_settings": _initial_player_settings(player),
                }
            )
        return snapshot

    @staticmethod
    def _seat(game: Any, player: Any) -> int:
        players = list(getattr(game, "players", ()))
        if type(player) is int and 0 <= player < len(players):
            return player
        for seat, candidate in enumerate(players):
            if candidate is player:
                return seat
        raise ValueError("player is not present in game.players")

    def _save_if_configured(self) -> None:
        if self.output_path is not None:
            self.save()

    def before_start(self, game: Any) -> None:
        """Capture the exact input and RNG position immediately before setup.

        A factory may already have consumed ``game.random`` while choosing
        decks.  The seed alone therefore cannot restore the setup stream.
        """

        from .game import Game
        from .replay_state import code_signature, serialize_rng_state

        self._players = self._snapshot_players(game)
        self._replay = {
            "format_version": 1,
            "game_class": "fireplace.game.Game" if type(game) is Game else None,
            "code_signature": code_signature(),
            "setup_rng_state": serialize_rng_state(game.random.getstate()),
            "final_state": None,
        }
        self._save_if_configured()

    def started(self, game: Any) -> None:
        """Record setup-derived values after ``game.start()`` has completed."""

        first_player = getattr(game, "player1", None)
        if first_player is None:
            players = list(getattr(game, "players", ()))
            first_player = next(
                (player for player in players if getattr(player, "first_player", False)),
                getattr(game, "current_player", None),
            )
        if first_player is not None:
            try:
                self._first_player_seat = self._seat(game, first_player)
            except ValueError:
                self._first_player_seat = None

        players = list(getattr(game, "players", ()))
        for seat, player in enumerate(players):
            if seat >= len(self._players):
                self._players.append(
                    {
                        "seat": seat,
                        "name": _player_name(player),
                        "hero_id": None,
                        "deck_card_ids": [],
                        "is_standard": bool(getattr(player, "is_standard", True)),
                        "initial_settings": _initial_player_settings(player),
                    }
                )
            entry = self._players[seat]
            entry["resolved_hero_id"] = _hero_id(player)
            entry["resolved_deck_card_ids"] = _deck_values(player)

        self._save_if_configured()

    def record(
        self,
        game: Any,
        player: Any,
        phase: Any,
        action: Any,
        turn: Any = None,
    ) -> None:
        """Append one accepted decision using its pre-action context."""

        if not hasattr(action, "to_dict"):
            raise TypeError("action must provide to_dict()")
        action_data = action.to_dict()
        if not isinstance(action_data, Mapping):
            raise TypeError("action.to_dict() must return a mapping")

        entry = {
            "seq": len(self._actions) + 1,
            "turn": _json_safe(getattr(game, "turn", None) if turn is None else turn),
            "player": self._seat(game, player),
            "phase": _json_safe(phase),
            "action": _json_safe(action_data),
        }
        self._actions.append(entry)
        self._save_if_configured()

    def finish(self, game: Any, status: str = "complete") -> None:
        """Store terminal player states and mark the log finished."""

        players = list(getattr(game, "players", ()))
        playstates = [_state_value(getattr(player, "playstate", None)) for player in players]
        winning_seats = [
            seat
            for seat, player in enumerate(players)
            if _state_is_won(getattr(player, "playstate", None))
        ]
        self._result = {
            "winning_seats": winning_seats,
            "playstates": playstates,
        }
        self._status = str(status)
        self._finished_at = _utc_now()
        if self._replay is not None:
            from .replay_state import normalized_game_state

            self._replay["final_state"] = normalized_game_state(game)
        self._save_if_configured()

    def to_dict(self) -> dict[str, Any]:
        """Return a detached JSON-compatible representation of this log."""

        result: dict[str, Any] = {
            "schema_version": self.schema_version,
            "game_id": self._game_id,
            "mode": self._mode,
            "source_revision": self._source_revision,
            "source_dirty": self._source_dirty,
            "started_at": self._started_at,
            "finished_at": self._finished_at,
            "status": self._status,
            "players": self._players,
            "first_player_seat": self._first_player_seat,
            "actions": self._actions,
            "result": self._result,
        }
        if self._replay is not None:
            result["replay"] = self._replay
        if self._seed is not None:
            result["seed"] = self._seed
        return _json_safe(result)

    def save(self, path: str | os.PathLike[str] | None = None) -> Path | None:
        """Atomically write the current log to ``path`` or ``output_path``."""

        target = Path(path) if path is not None else self.output_path
        if target is None:
            return None
        target.parent.mkdir(parents=True, exist_ok=True)

        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=target.parent,
                prefix=".%s." % target.name,
                suffix=".tmp",
                delete=False,
            ) as stream:
                temporary_path = stream.name
                json.dump(self.to_dict(), stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, target)
            temporary_path = None
        except Exception:
            # Ordinary write errors should not leave a litter of temporary
            # files.  BaseException (for example KeyboardInterrupt) bypasses
            # this cleanup and leaves the partial temporary document for
            # inspection while the previous target remains intact.
            if temporary_path is not None:
                try:
                    os.unlink(temporary_path)
                except OSError:
                    pass
            raise
        return target


__all__ = ["ActionLog", "SCHEMA_VERSION"]
