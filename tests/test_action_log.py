"""The input log records accepted player decisions, not engine effects."""

import json

import pytest
from hearthstone.enums import CardClass

from fireplace import cards
from fireplace import action_log as action_log_module
from fireplace.action_log import ActionLog
from fireplace.agent_api import Action
from fireplace.agents import RandomAgent
from fireplace.controller import ActionError, GameSession, decision_player
from fireplace.exceptions import GameOver
from fireplace.game import Game
from fireplace.player import Player


cards.db.initialize()


def make_session(tmp_path, *, deck=None, hero=None):
    deck = deck or ["CS2_231"] * 5
    hero = hero or CardClass.MAGE.default_hero
    players = (Player("Alpha", deck[:], hero), Player("Beta", deck[:], hero))
    game = Game(players, seed=4)
    path = tmp_path / "match.json"
    log = ActionLog(game, mode="test_match", output_path=path,
                    game_id="fixed-test-game", source_revision="test-revision")
    agents = {player: RandomAgent(seed=i) for i, player in enumerate(players)}
    return GameSession(game, agents, action_log=log), path


def finish_mulligan(session):
    session.start()
    for _ in range(2):
        session.execute(decision_player(session.game), Action(type="MULLIGAN"))


def test_rejected_actions_do_not_enter_persisted_log(tmp_path):
    session, path = make_session(tmp_path)
    session.start()
    player = decision_player(session.game)
    initial = json.loads(path.read_text(encoding="utf-8"))
    assert initial["game_id"] == "fixed-test-game"
    assert initial["source_revision"] == "test-revision"
    assert initial["players"][0]["deck_card_ids"] == ["CS2_231"] * 5
    assert initial["actions"] == []

    with pytest.raises(ActionError):
        session.execute(player, Action(type="CHOOSE", choice_entity_id=99999))
    assert json.loads(path.read_text(encoding="utf-8"))["actions"] == []

    session.execute(player, Action(type="MULLIGAN"))
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert len(saved["actions"]) == 1
    assert saved["actions"][0]["seq"] == 1
    assert saved["actions"][0]["phase"] == "MULLIGAN"
    assert saved["actions"][0]["player"] == session.game.players.index(player)
    assert saved["actions"][0]["action"]["type"] == "MULLIGAN"


def test_choice_logged_as_player_input(tmp_path):
    session, _ = make_session(tmp_path, hero=CardClass.PRIEST.default_hero)
    finish_mulligan(session)
    player = session.game.current_player
    player.max_mana = 10
    curator = player.give("LOE_006")
    play = next(action for action in session.legal_actions(player)
                if action.type == "PLAY_CARD" and action.source_entity_id == curator.entity_id)
    session.execute(player, play)
    choice = session.legal_actions(player)[0]
    session.execute(player, choice)

    records = session.action_log.to_dict()["actions"]
    assert [record["seq"] for record in records] == list(range(1, len(records) + 1))
    assert records[-1]["phase"] == "CHOICE"
    assert records[-1]["action"] == choice.to_dict()
    assert all(record["action"]["type"] in {
        "MULLIGAN", "PLAY_CARD", "CHOOSE"
    } for record in records)


def test_complete_game_log_includes_terminal_decision_and_result(tmp_path):
    session, path = make_session(tmp_path)
    result = session.run()
    assert result.ended
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved == session.action_log.to_dict()
    assert saved["status"] == "complete"
    assert saved["finished_at"] is not None
    assert saved["actions"]
    assert saved["actions"][-1]["seq"] == len(saved["actions"])
    assert saved["result"]["winning_seats"]
    assert saved["first_player_seat"] == result.players.index(result.player1)


def test_game_over_exception_still_records_lethal_action(tmp_path):
    session, path = make_session(tmp_path)
    finish_mulligan(session)
    player = session.game.current_player
    player.max_mana = 10
    player.opponent.hero.damage = 29
    spell = player.give("CS2_029")
    lethal = next(action for action in session.legal_actions(player)
                  if action.type == "PLAY_CARD"
                  and action.source_entity_id == spell.entity_id
                  and action.target_entity_id == player.opponent.hero.entity_id)
    before = len(session.action_log.to_dict()["actions"])
    with pytest.raises(GameOver):
        session.execute(player, lethal)
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert len(saved["actions"]) == before + 1
    assert saved["actions"][-1]["action"] == lethal.to_dict()
    assert saved["status"] == "complete"
    assert saved["result"]["winning_seats"] == [session.game.players.index(player)]


def test_failed_file_sync_keeps_previous_complete_json(tmp_path, monkeypatch):
    session, path = make_session(tmp_path)
    previous = path.read_bytes()

    def fail_sync(_fd):
        raise OSError("simulated storage failure")

    monkeypatch.setattr(action_log_module.os, "fsync", fail_sync)
    with pytest.raises(OSError, match="simulated storage failure"):
        session.start()
    assert path.read_bytes() == previous
    assert not list(tmp_path.glob(".match.json.*.tmp"))
