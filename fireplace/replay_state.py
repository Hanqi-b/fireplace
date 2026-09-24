"""Stable, JSON-safe values used to verify deterministic game replay.

The engine objects contain UUIDs, callbacks, and other implementation details
which are useful while a game is running but make a full object dump unsuitable
for replay comparison.  This module deliberately builds a small value tree
from the parts of a game that affect its observable rules state.

The public helpers are:

normalized_game_state(game)
    Return a detached snapshot of the game.  UUIDs and the wall-clock
    turn_start value are intentionally omitted.

serialize_rng_state(state) / restore_rng_state(value)
    Convert the tuple tree returned by random.Random.getstate to and
    from JSON arrays without losing the tuple structure required by
    random.Random.setstate.

code_signature()
    Return source and runtime metadata used to reject replay under a different
    Python/dependency/source version.

This module has no dependency on the controller or action log so it can be
used by either side of the replay boundary without creating an import cycle.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from enum import Enum
from pathlib import Path
from typing import Any

try:  # Python 3.8+
    from importlib import metadata as _importlib_metadata
except ImportError:  # pragma: no cover - exercised only on older Python
    try:
        import importlib_metadata as _importlib_metadata
    except ImportError:  # pragma: no cover - optional compatibility fallback
        _importlib_metadata = None


SCHEMA_VERSION = 1
_MISSING = object()
_OPTIONAL_ATTRIBUTE_ERRORS = (
    AttributeError,
    KeyError,
    IndexError,
    TypeError,
    ValueError,
)


def _read(obj: Any, name: str, default: Any = _MISSING) -> Any:
    """Read an attribute which may not exist before game setup.

    Fireplace has a few computed properties whose backing objects are only
    attached during setup.  Catching the small set of lookup/conversion errors
    those properties can raise keeps a pre-start snapshot useful without
    hiding arbitrary engine failures.
    """

    if obj is None:
        return default
    try:
        return getattr(obj, name)
    except _OPTIONAL_ATTRIBUTE_ERRORS:
        return default


def _scalar(value: Any) -> Any:
    """Return a JSON scalar, normalizing enum values along the way."""

    # IntEnum is also an int subclass; normalize it before the scalar type
    # check so snapshots contain ordinary JSON integers rather than enum
    # instances.  This matters when comparing a live snapshot with its JSON
    # round trip.
    if isinstance(value, Enum):
        return _scalar(value.value)
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        # JSON's standard representation has no NaN/Infinity values.  These
        # are not expected in engine state, but retaining a deterministic text
        # value keeps this function JSON-safe for a lightweight test double.
        if math.isfinite(value):
            return value
        return repr(value)
    if isinstance(value, Path):
        return value.as_posix()
    raise TypeError("replay state contains a non-scalar value: %r" % (type(value),))


def _optional_scalar(value: Any) -> Any:
    if value is _MISSING:
        return _MISSING
    try:
        return _scalar(value)
    except TypeError:
        return _MISSING


def _field(obj: Any, name: str) -> Any:
    """Read one optional scalar field, using JSON null when it is absent."""

    value = _optional_scalar(_read(obj, name))
    return None if value is _MISSING else value


def _entity_id(entity: Any) -> Any:
    return _optional_scalar(_read(entity, "entity_id"))


def _card_id(card: Any) -> Any:
    """Read a card definition id without using an object's repr."""

    if isinstance(card, (str, bool, int, float)):
        return _scalar(card)
    card_id = _read(card, "id")
    if card_id is _MISSING:
        data = _read(card, "data")
        card_id = _read(data, "id")
    if card_id is _MISSING:
        return None
    value = _optional_scalar(card_id)
    return None if value is _MISSING else value


def _cards(value: Any) -> list[Any]:
    if value is _MISSING or value is None:
        return []
    try:
        return list(value)
    except (TypeError, ValueError):
        return []


def _card_buff_ids(card: Any) -> list[Any]:
    buffs = _read(card, "buffs")
    if buffs is _MISSING or buffs is None:
        return []
    result = []
    for buff in _cards(buffs):
        buff_id = _read(buff, "id")
        if buff_id is _MISSING and isinstance(buff, (str, bool, int, float)):
            buff_id = buff
        value = _optional_scalar(buff_id)
        if value is not _MISSING:
            result.append(value)
    return result


# These fields are intentionally explicit.  They cover current values that
# affect rule resolution while avoiding callbacks, source/controller links,
# and other engine objects.  A property is included only when the card has it;
# this keeps normal cards and small test doubles equally useful.
_CARD_FIELDS = (
    "type",
    "zone",
    "zone_position",
    "cost",
    "atk",
    "max_health",
    "health",
    "damage",
    "armor",
    "durability",
    "max_durability",
    "progress",
    "progress_total",
    "spellpower",
    "overload",
    "turns_in_play",
    "turn_killed",
    "damaged_this_turn",
    "healed_this_turn",
    "num_attacks",
    "turn_drawn",
    "turn_played",
    "dormant_turns",
    "play_counter",
    "frozen",
    "exhausted",
    "cant_attack",
    "taunt",
    "divine_shield",
    "stealthed",
    "poisonous",
    "windfury",
    "mega_windfury",
    "lifesteal",
    "rush",
    "charge",
    "reborn",
    "dormant",
    "silenced",
    "has_deathrattle",
    "has_inspire",
    "has_overkill",
    "has_choose_one",
    "has_discover",
    "one_turn_effect",
    "race",
    "card_class",
)


def _card_state(card: Any) -> dict[str, Any] | None:
    if card is None or card is _MISSING:
        return None

    entity_id = _entity_id(card)
    result: dict[str, Any] = {
        "entity_id": None if entity_id is _MISSING else entity_id,
        "card_id": _card_id(card),
        "zone": None,
        "buff_ids": _card_buff_ids(card),
    }
    for field in _CARD_FIELDS:
        value = _optional_scalar(_read(card, field))
        if value is not _MISSING:
            # zone is part of the stable card identity and is always present,
            # even for a partially initialized test double.
            if field == "zone":
                result["zone"] = value
            else:
                result[field] = value
    return result


def _choice_state(choice: Any) -> dict[str, Any] | None:
    if choice is None or choice is _MISSING:
        return None
    choice_type = _read(choice, "__class__")
    result: dict[str, Any] = {
        "type": getattr(choice_type, "__name__", None),
        "cards": [_card_state(card) for card in _cards(_read(choice, "cards"))],
    }
    for field in ("min_count", "max_count"):
        value = _optional_scalar(_read(choice, field))
        if value is not _MISSING:
            result[field] = value
    return result


_RESOURCE_FIELDS = (
    "mana",
    "max_mana",
    "max_resources",
    "used_mana",
    "temp_mana",
    "overloaded",
    "overload_locked",
    "overloaded_this_game",
)


def _player_card_list(player: Any, name: str) -> list[dict[str, Any] | None]:
    return [_card_state(card) for card in _cards(_read(player, name))]


def _player_state(player: Any, seat: int) -> dict[str, Any]:
    hero = _read(player, "hero")
    hero_power = _read(player, "hero_power")
    if hero_power is _MISSING:
        hero_power = _read(hero, "power")
    weapon = _read(player, "weapon")

    result: dict[str, Any] = {
        "seat": seat,
        "name": _field(player, "name"),
        "first_player": _field(player, "first_player"),
        "playstate": _field(player, "playstate"),
        "turn": _field(player, "turn"),
        "last_turn": _field(player, "last_turn"),
        "fatigue_counter": _field(player, "fatigue_counter"),
        "starting_hero": _card_id(_read(player, "starting_hero")),
        "starting_deck": [
            _card_id(card) for card in _cards(_read(player, "starting_deck"))
        ],
        "hero": _card_state(None if hero is _MISSING else hero),
        "weapon": _card_state(None if weapon is _MISSING else weapon),
        "hero_power": _card_state(None if hero_power is _MISSING else hero_power),
        "pending_choice": _choice_state(_read(player, "choice")),
        "hand": _player_card_list(player, "hand"),
        "deck": _player_card_list(player, "deck"),
        "field": _player_card_list(player, "field"),
        "graveyard": _player_card_list(player, "graveyard"),
        "secrets": _player_card_list(player, "secrets"),
    }

    resources: dict[str, Any] = {}
    for field in _RESOURCE_FIELDS:
        value = _optional_scalar(_read(player, field))
        if value is _MISSING:
            value = None
        result[field] = value
        resources[field] = value
    result["resources"] = resources

    # These counters/flags affect future turns and are cheap to retain.  They
    # are kept flat so callers can inspect a snapshot without knowing engine
    # implementation classes.
    for field in (
        "combo",
        "cant_draw",
        "cant_fatigue",
        "cards_drawn_this_turn",
        "cards_played_this_turn",
        "minions_killed_this_turn",
        "minions_played_this_turn",
        "times_hero_power_used_this_game",
        "elemental_played_this_turn",
        "elemental_played_last_turn",
        "invoke_counter",
    ):
        value = _optional_scalar(_read(player, field))
        if value is not _MISSING:
            result[field] = value
    return result


def _seat(players: list[Any], player: Any) -> int | None:
    if player is None or player is _MISSING:
        return None
    for seat, candidate in enumerate(players):
        if candidate is player:
            return seat
    return None


def _rng_state_digest(game: Any) -> str | None:
    random_object = _read(game, "random")
    if random_object is _MISSING or random_object is None:
        return None
    getstate = _read(random_object, "getstate")
    if getstate is _MISSING or not callable(getstate):
        return None
    try:
        state = getstate()
    except _OPTIONAL_ATTRIBUTE_ERRORS:
        return None
    encoded = json.dumps(
        serialize_rng_state(state),
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("ascii")
    return hashlib.sha256(encoded).hexdigest()


def normalized_game_state(game: Any) -> dict[str, Any]:
    """Return a deterministic, JSON-safe snapshot of a Fireplace game.

    The snapshot intentionally excludes every UUID and the player
    turn_start wall-clock timestamp.  Ordered zone lists are preserved so
    deck/hand/board ordering remains part of replay equality.
    """

    players = _cards(_read(game, "players"))
    current_player = _read(game, "current_player")
    first_player = _read(game, "player1")
    if first_player is _MISSING:
        first_player = next(
            (
                player
                for player in players
                if _read(player, "first_player") is True
            ),
            None,
        )

    result: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "turn": _field(game, "turn"),
        "state": _field(game, "state"),
        "step": _field(game, "step"),
        "next_step": _field(game, "next_step"),
        "current_player_seat": _seat(players, current_player),
        "first_player_seat": _seat(players, first_player),
        "rng_state_digest": _rng_state_digest(game),
        "players": [_player_state(player, seat) for seat, player in enumerate(players)],
        "setaside": [
            _card_state(card) for card in _cards(_read(game, "setaside"))
        ],
    }

    # A choice belongs to a player in the engine, but this compact index makes
    # pending decisions easy to inspect without scanning all player records.
    result["pending_choices"] = [
        {"seat": seat, "choice": player_state["pending_choice"]}
        for seat, player_state in enumerate(result["players"])
        if player_state["pending_choice"] is not None
    ]
    return result


def serialize_rng_state(state: Any) -> Any:
    """Convert a Random.getstate tuple tree to JSON-compatible lists."""

    if isinstance(state, tuple):
        return [serialize_rng_state(value) for value in state]
    if isinstance(state, list):
        return [serialize_rng_state(value) for value in state]
    if isinstance(state, dict):
        return {
            str(key): serialize_rng_state(value)
            for key, value in state.items()
        }
    return _scalar(state)


def restore_rng_state(value: Any) -> Any:
    """Restore the tuple tree expected by Random.setstate()."""

    if isinstance(value, list):
        return tuple(restore_rng_state(item) for item in value)
    if isinstance(value, tuple):
        return tuple(restore_rng_state(item) for item in value)
    if isinstance(value, dict):
        return {key: restore_rng_state(item) for key, item in value.items()}
    return value


def _installed_version(distribution: str, module_name: str) -> str | None:
    if _importlib_metadata is not None:
        try:
            return str(_importlib_metadata.version(distribution))
        except _importlib_metadata.PackageNotFoundError:
            pass
        except ValueError:
            pass
    try:
        module = __import__(module_name)
    except ImportError:
        return None
    version = getattr(module, "__version__", None)
    if version is None:
        version = getattr(module, "VERSION", None)
    return None if version is None else str(version)


def code_signature() -> dict[str, Any]:
    """Return source hash and runtime metadata for replay compatibility."""

    source_root = Path(__file__).resolve().parent
    source_files = sorted(
        (
            path for path in source_root.rglob("*")
            if path.is_file() and (path.suffix == ".py" or path.name == "CardDefs.xml")
        ),
        key=lambda path: path.relative_to(source_root).as_posix(),
    )
    digest = hashlib.sha256()
    for path in source_files:
        relative = path.relative_to(source_root).as_posix()
        # Include path boundaries as well as contents so concatenation cannot
        # make two different file sets share one digest accidentally.
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")

    hearthstone_version = _installed_version("hearthstone", "hearthstone")
    hearthstone_data_version = _installed_version(
        "hearthstone-data", "hearthstone_data"
    )
    python_version = "%d.%d" % (sys.version_info.major, sys.version_info.minor)
    return {
        "schema_version": SCHEMA_VERSION,
        "source_sha256": digest.hexdigest(),
        "python_version": python_version,
        "python_major": sys.version_info.major,
        "python_minor": sys.version_info.minor,
        "hearthstone_version": hearthstone_version,
        "hearthstone_data_version": hearthstone_data_version,
        "dependencies": {
            "hearthstone": hearthstone_version,
            "hearthstone-data": hearthstone_data_version,
        },
    }


__all__ = [
    "SCHEMA_VERSION",
    "code_signature",
    "normalized_game_state",
    "restore_rng_state",
    "serialize_rng_state",
]
