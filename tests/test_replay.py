"""A complete decision log must reconstruct the same game from its start."""

import copy
import json

import pytest
from hearthstone.enums import CardClass

from fireplace import cards
from fireplace.action_log import ActionLog
from fireplace.agents import RandomAgent
from fireplace.controller import GameSession
from fireplace.game import Game
from fireplace.player import Player
from fireplace.replay import ReplayError, replay_action_log
from fireplace.replay_state import normalized_game_state
from fireplace.utils import setup_game


cards.db.initialize()


def recorded_match(tmp_path, *, deck=None, seed=19, consume_before_start=False,
                   first_hand_size=None):
    deck = deck or ["CS2_231"] * 5
    hero = CardClass.MAGE.default_hero
    players = (Player("Alpha", deck[:], hero), Player("Beta", deck[:], hero))
    if first_hand_size is not None:
        players[0]._start_hand_size = first_hand_size
    game = Game(players, seed=seed)
    if consume_before_start:
        game.random.random()
        game.random.random()
    path = tmp_path / "replay.json"
    log = ActionLog(game, output_path=path)
    agents = {player: RandomAgent(seed=seat + 100) for seat, player in enumerate(players)}
    GameSession(game, agents, action_log=log).run()
    return game, path, json.loads(path.read_text(encoding="utf-8"))


def test_complete_log_replays_from_json_and_matches_state(tmp_path):
    original, path, saved = recorded_match(tmp_path, consume_before_start=True)
    replayed = replay_action_log(path)
    replayed_again = replay_action_log(saved)
    expected = normalized_game_state(original)
    assert normalized_game_state(replayed) == expected
    assert normalized_game_state(replayed_again) == expected
    assert saved["replay"]["final_state"] == expected
    assert saved["seed"] == 19


def test_replay_rejects_changed_code_and_action(tmp_path):
    _, _, saved = recorded_match(tmp_path)
    changed = copy.deepcopy(saved)
    changed["replay"]["code_signature"] = "wrong"
    with pytest.raises(ReplayError, match="code or dependency"):
        replay_action_log(changed)

    changed = copy.deepcopy(saved)
    changed["actions"][0]["action"] = {"schema_version": 1, "type": "END_TURN"}
    with pytest.raises(ReplayError, match="Action 1 diverged"):
        replay_action_log(changed)


def test_replay_rejects_log_without_prestart_snapshot(tmp_path):
    _, _, saved = recorded_match(tmp_path)
    saved.pop("replay")
    with pytest.raises(ReplayError, match="replay metadata"):
        replay_action_log(saved)


def test_replay_rejects_changed_initial_deck(tmp_path):
    _, _, saved = recorded_match(tmp_path)
    saved["players"][0]["deck_card_ids"][0] = "CS2_029"
    with pytest.raises(ReplayError, match="setup diverged"):
        replay_action_log(saved)


def test_seed_controls_random_class_and_deck_setup():
    first = setup_game(seed=73, start=False)
    second = setup_game(seed=73, start=False)
    assert [(player.starting_hero, player.starting_deck) for player in first.players] == [
        (player.starting_hero, player.starting_deck) for player in second.players
    ]
    assert first.random.getstate() == second.random.getstate()


def test_discover_choice_replays_with_generated_entity_ids(tmp_path):
    original, _, saved = recorded_match(tmp_path, deck=["LOE_006"] * 5)
    assert any(entry["action"]["type"] == "CHOOSE" for entry in saved["actions"])
    replayed = replay_action_log(saved)
    assert normalized_game_state(replayed) == normalized_game_state(original)


def test_nondefault_initial_hand_size_replays(tmp_path):
    original, _, saved = recorded_match(tmp_path, first_hand_size=1)
    assert saved["players"][0]["initial_settings"]["_start_hand_size"] == 1
    assert normalized_game_state(replay_action_log(saved)) == normalized_game_state(original)


def test_bytes_seed_is_saved_as_provenance_and_replays(tmp_path):
    original, _, saved = recorded_match(tmp_path, seed=b"custom-seed")
    assert saved["seed"] == {"type": "bytes", "hex": b"custom-seed".hex()}
    assert normalized_game_state(replay_action_log(saved)) == normalized_game_state(original)


def test_normalized_state_does_not_consume_game_rng():
    hero = CardClass.MAGE.default_hero
    players = (
        Player("Alpha", ["KAR_702"] * 5, hero),
        Player("Beta", ["KAR_702"] * 5, hero),
    )
    game = Game(players, seed=12)
    GameSession(game, {}).start()
    before = game.random.getstate()
    normalized_game_state(game)
    assert game.random.getstate() == before
