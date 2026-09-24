"""Replay a complete decision log from the beginning of a standard game."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from . import cards
from .action_log import _INITIAL_PLAYER_FIELDS
from .agent_api import Action
from .controller import ActionError, GameSession, decision_player, phase_for
from .exceptions import GameOver
from .game import Game
from .player import Player
from .replay_state import code_signature, normalized_game_state, restore_rng_state


class ReplayError(ValueError):
    """A log cannot be replayed or diverges from its recorded game."""


def _load_log(value: Mapping[str, Any] | str | Path) -> dict[str, Any]:
    if isinstance(value, (str, Path)):
        try:
            with Path(value).open(encoding="utf-8") as stream:
                value = json.load(stream)
        except (OSError, json.JSONDecodeError) as exc:
            raise ReplayError("Cannot read action log: %s" % exc) from exc
    if not isinstance(value, dict):
        raise ReplayError("Action log must be a JSON object")
    return value


def _first_difference(expected: Any, actual: Any, path: str = "state") -> str | None:
    if type(expected) is not type(actual):
        return path
    if isinstance(expected, dict):
        if expected.keys() != actual.keys():
            return path + ".keys"
        for key in expected:
            difference = _first_difference(expected[key], actual[key], path + "." + str(key))
            if difference is not None:
                return difference
    elif isinstance(expected, list):
        if len(expected) != len(actual):
            return path + ".length"
        for index, (left, right) in enumerate(zip(expected, actual)):
            difference = _first_difference(left, right, path + "[%d]" % index)
            if difference is not None:
                return difference
    elif expected != actual:
        return path
    return None


def replay_action_log(value: Mapping[str, Any] | str | Path) -> Game:
    """Recreate a complete standard game and verify its normalized final state.

    Logs made by attaching to an already-started game cannot be replayed:
    they have no pre-setup RNG state.  Source and dependency versions must
    match the logging process exactly.
    """

    log = _load_log(value)
    if type(log.get("schema_version")) is not int or log["schema_version"] != 1:
        raise ReplayError("Unsupported action log schema_version")
    if log.get("status") != "complete":
        raise ReplayError("Replay requires a complete action log")
    replay = log.get("replay")
    if not isinstance(replay, dict) or replay.get("format_version") != 1:
        raise ReplayError("Action log has no supported replay metadata")
    if replay.get("game_class") != "fireplace.game.Game":
        raise ReplayError("Replay supports standard fireplace.game.Game only")
    if replay.get("code_signature") != code_signature():
        raise ReplayError("Game code or dependency version differs from the log")
    if not isinstance(replay.get("setup_rng_state"), list):
        raise ReplayError("Action log has no pre-start RNG state")
    if not isinstance(replay.get("final_state"), dict):
        raise ReplayError("Action log has no normalized final state")

    player_data = log.get("players")
    if not isinstance(player_data, list) or len(player_data) != 2:
        raise ReplayError("Action log requires two player configurations")
    players = []
    for seat, entry in enumerate(player_data):
        if not isinstance(entry, dict) or entry.get("seat") != seat:
            raise ReplayError("Invalid player seat %d" % seat)
        name, hero, deck = entry.get("name"), entry.get("hero_id"), entry.get("deck_card_ids")
        if not isinstance(name, str) or not isinstance(hero, str) or not isinstance(deck, list) or not all(isinstance(card, str) for card in deck):
            raise ReplayError("Invalid player configuration at seat %d" % seat)
        is_standard = entry.get("is_standard", True)
        if type(is_standard) is not bool:
            raise ReplayError("Invalid is_standard at seat %d" % seat)
        settings = entry.get("initial_settings")
        if not isinstance(settings, dict) or set(settings) != set(_INITIAL_PLAYER_FIELDS):
            raise ReplayError("Invalid initial player settings at seat %d" % seat)
        for field in _INITIAL_PLAYER_FIELDS:
            expected_type = bool if field in ("cant_draw", "cant_fatigue") else int
            if type(settings[field]) is not expected_type:
                raise ReplayError("Invalid %s at seat %d" % (field, seat))
        player = Player(name, deck[:], hero, is_standard=is_standard)
        for field in _INITIAL_PLAYER_FIELDS:
            setattr(player, field, settings[field])
        players.append(player)

    actions = log.get("actions")
    if not isinstance(actions, list):
        raise ReplayError("Action log actions must be a list")
    cards.db.initialize()
    # The captured pre-start state is authoritative.  The provenance seed may
    # be bytes or may have been consumed while drafting before it was saved.
    game = Game(tuple(players))
    try:
        game.random.setstate(restore_rng_state(replay["setup_rng_state"]))
    except (TypeError, ValueError) as exc:
        raise ReplayError("Invalid pre-start RNG state") from exc
    session = GameSession(game, {})
    try:
        session.start()
    except Exception as exc:
        raise ReplayError("Game setup diverged: %s" % exc) from exc

    first_player = log.get("first_player_seat")
    if type(first_player) is not int or first_player != game.players.index(game.player1):
        raise ReplayError("First player diverged during setup")
    for seat, (entry, player) in enumerate(zip(player_data, game.players)):
        actual = session.action_log.to_dict()["players"][seat]
        if (entry.get("resolved_hero_id") != actual.get("resolved_hero_id")
                or entry.get("resolved_deck_card_ids") != actual.get("resolved_deck_card_ids")):
            raise ReplayError("Player %d setup diverged" % seat)

    for index, entry in enumerate(actions, 1):
        if not isinstance(entry, dict) or type(entry.get("seq")) is not int or entry["seq"] != index:
            raise ReplayError("Invalid action sequence at entry %d" % index)
        player = decision_player(game)
        if player is None:
            raise ReplayError("Action %d occurs after game over" % index)
        seat = game.players.index(player)
        phase = phase_for(game, player)
        if (entry.get("player") != seat or entry.get("turn") != game.turn
                or entry.get("phase") != phase):
            raise ReplayError("Action %d context diverged (turn/player/phase)" % index)
        try:
            action = Action.from_dict(entry.get("action"))
            session.execute(player, action)
        except GameOver:
            if index != len(actions):
                raise ReplayError("Action %d ended the game before the log ended" % index)
        except (ActionError, ValueError, TypeError) as exc:
            raise ReplayError("Action %d diverged: %s" % (index, exc)) from exc

    if not game.ended:
        raise ReplayError("Action log ended before the game")
    actual_result = session.action_log.to_dict()["result"]
    if actual_result != log.get("result"):
        raise ReplayError("Final result diverged")
    actual_state = normalized_game_state(game)
    difference = _first_difference(replay["final_state"], actual_state)
    if difference is not None:
        raise ReplayError("Final normalized state diverged at %s" % difference)
    return game


__all__ = ["ReplayError", "replay_action_log"]
