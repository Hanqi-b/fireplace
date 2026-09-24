import pytest
from hearthstone.enums import CardClass

from fireplace import cards
from fireplace.agent_api import Action
from fireplace.controller import GameSession, decision_player
from fireplace.game import Game
from fireplace.heuristic_agent import HeuristicAgent
from fireplace.player import Player


cards.db.initialize()


def observation(*, phase="MAIN", self_view=None, opponent=None, pending_choice=None):
    return {
        "phase": phase,
        "self": self_view or {},
        "opponent": opponent or {},
        "pending_choice": pending_choice,
    }


def test_mulligan_replaces_high_cost_cards_only():
    agent = HeuristicAgent()
    actions = [
        Action(type="MULLIGAN"),
        Action(type="MULLIGAN", mulligan_entity_ids=(11,)),
        Action(type="MULLIGAN", mulligan_entity_ids=(12,)),
        Action(type="MULLIGAN", mulligan_entity_ids=(13,)),
        Action(type="MULLIGAN", mulligan_entity_ids=(11, 12, 13)),
        Action(type="MULLIGAN", mulligan_entity_ids=(12, 13)),
    ]
    view = observation(
        phase="MULLIGAN",
        pending_choice={
            "options": [
                {"entity_id": 11, "cost": 1},
                {"entity_id": 12, "cost": 7},
                {"entity_id": 13, "cost": 5},
            ]
        },
    )

    chosen = agent.choose_action(view, actions)

    assert chosen == Action(type="MULLIGAN", mulligan_entity_ids=(12, 13))
    assert chosen in actions


def test_choice_uses_available_mana_without_inventing_options():
    agent = HeuristicAgent()
    actions = [
        Action(type="CHOOSE", choice_entity_id=31),
        Action(type="CHOOSE", choice_entity_id=33),
        Action(type="CHOOSE", choice_entity_id=32),
    ]
    view = observation(
        phase="CHOICE",
        self_view={"mana": 5},
        pending_choice={
            "options": [
                {"entity_id": 31, "cost": 1},
                {"entity_id": 32, "cost": 5},
                {"entity_id": 33, "cost": 6},
            ]
        },
    )

    chosen = agent.choose_action(view, actions)

    assert chosen == Action(type="CHOOSE", choice_entity_id=32)
    assert chosen in actions


def test_main_phase_takes_visible_lethal_attack():
    agent = HeuristicAgent()
    face = Action(type="ATTACK", source_entity_id=1, target_entity_id=2)
    trade = Action(type="ATTACK", source_entity_id=10, target_entity_id=20)
    end = Action(type="END_TURN")
    view = observation(
        self_view={
            "hero": {"entity_id": 1, "atk": 3},
            "board": [{"entity_id": 10, "atk": 2, "health": 2}],
        },
        opponent={
            "hero": {"entity_id": 2, "health": 3, "armor": 0},
            "board": [{"entity_id": 20, "atk": 1, "health": 1}],
        },
    )

    chosen = agent.choose_action(view, [trade, end, face])

    assert chosen == face


def test_main_phase_makes_a_favorable_minion_trade():
    agent = HeuristicAgent()
    trade = Action(type="ATTACK", source_entity_id=10, target_entity_id=20)
    face = Action(type="ATTACK", source_entity_id=10, target_entity_id=2)
    end = Action(type="END_TURN")
    view = observation(
        self_view={
            "hero": {"entity_id": 1, "atk": 0},
            "board": [{"entity_id": 10, "atk": 3, "health": 4}],
        },
        opponent={
            "hero": {"entity_id": 2, "health": 20, "armor": 0},
            "board": [{"entity_id": 20, "atk": 3, "health": 3}],
        },
    )

    chosen = agent.choose_action(view, [face, end, trade])

    assert chosen == trade


def test_main_phase_attacks_face_when_there_is_no_profitable_trade():
    agent = HeuristicAgent()
    face = Action(type="ATTACK", source_entity_id=10, target_entity_id=2)
    bad_trade = Action(type="ATTACK", source_entity_id=10, target_entity_id=20)
    end = Action(type="END_TURN")
    view = observation(
        self_view={"hero": {"entity_id": 1},
                   "board": [{"entity_id": 10, "atk": 2, "health": 2}]},
        opponent={"hero": {"entity_id": 2, "health": 30, "armor": 0},
                  "board": [{"entity_id": 20, "atk": 4, "health": 5}]},
    )

    assert agent.choose_action(view, [bad_trade, end, face]) == face


def test_targeted_hero_power_prefers_an_opponent_over_own_hero():
    agent = HeuristicAgent()
    self_target = Action(type="USE_HERO_POWER", source_entity_id=21,
                         target_entity_id=1)
    opponent_target = Action(type="USE_HERO_POWER", source_entity_id=21,
                             target_entity_id=2)
    view = observation(
        self_view={"hero": {"entity_id": 1, "health": 30},
                   "hero_power": {"entity_id": 21, "cost": 2,
                                  "is_usable": True}},
        opponent={"hero": {"entity_id": 2, "health": 30}, "board": []},
    )

    assert agent.choose_action(view, [self_target, opponent_target]) == opponent_target


def test_priest_heal_and_buff_use_friendly_targets_from_real_legal_actions():
    deck = ["CS2_231"] * 10
    first = Player("Priest One", deck[:], CardClass.PRIEST.default_hero)
    second = Player("Priest Two", deck[:], CardClass.PRIEST.default_hero)
    game = Game((first, second), seed=9)
    session = GameSession(game, {})
    session.start()
    for _ in range(2):
        session.execute(decision_player(game), Action(type="MULLIGAN"))
    actor = decision_player(game)
    actor.max_mana = 10
    actions = [action for action in session.legal_actions(actor)
               if action.type == "USE_HERO_POWER"]
    assert any(action.target_entity_id == actor.hero.entity_id
               for action in actions)
    assert any(action.target_entity_id == actor.opponent.hero.entity_id
               for action in actions)

    assert HeuristicAgent().choose_action(
        session.observation(actor), actions + [Action(type="END_TURN")]
    ) == Action(type="END_TURN")

    actor.hero.damage = 2

    chosen = HeuristicAgent().choose_action(session.observation(actor), actions)

    assert chosen.target_entity_id == actor.hero.entity_id

    friendly = actor.summon("CS2_231")
    enemy = actor.opponent.summon("CS2_231")
    shield = actor.give("CS2_004")
    shield_actions = [action for action in session.legal_actions(actor)
                      if action.type == "PLAY_CARD"
                      and action.source_entity_id == shield.entity_id]
    assert any(action.target_entity_id == friendly.entity_id
               for action in shield_actions)
    assert any(action.target_entity_id == enemy.entity_id
               for action in shield_actions)

    chosen = HeuristicAgent().choose_action(
        session.observation(actor), shield_actions
    )

    assert chosen.target_entity_id == friendly.entity_id


@pytest.mark.parametrize(
    "card_id",
    ["HERO_09bp2", "CS1h_001_H1", "CS1h_001_H2",
     "CS1h_001_H1_AT_132", "CS1h_001_H2_AT_132"],
)
def test_priest_heal_variants_choose_injured_friendly_hero(card_id):
    own = Action(type="USE_HERO_POWER", source_entity_id=21, target_entity_id=1)
    enemy = Action(type="USE_HERO_POWER", source_entity_id=21, target_entity_id=2)
    view = observation(
        self_view={"hero": {"entity_id": 1, "health": 28,
                            "max_health": 30, "damage": 2},
                   "hero_power": {"entity_id": 21, "card_id": card_id,
                                  "cost": 2, "is_usable": True}},
        opponent={"hero": {"entity_id": 2, "health": 28,
                           "max_health": 30, "damage": 2}},
    )

    assert HeuristicAgent().choose_action(view, [enemy, own]) == own


def test_life_tap_does_not_choose_lethal_self_damage():
    tap = Action(type="USE_HERO_POWER", source_entity_id=21)
    end = Action(type="END_TURN")
    view = observation(
        self_view={"hero": {"entity_id": 1, "health": 1, "armor": 0},
                   "hero_power": {"entity_id": 21, "card_id": "HERO_07bp",
                                  "cost": 2, "is_usable": True},
                   "deck_count": 10},
    )

    assert HeuristicAgent().choose_action(view, [tap, end]) == end


def test_attack_breaks_a_divine_shield_taunt():
    attack = Action(type="ATTACK", source_entity_id=10, target_entity_id=20)
    end = Action(type="END_TURN")
    view = observation(
        self_view={"hero": {"entity_id": 1},
                   "board": [{"entity_id": 10, "atk": 3, "health": 3}]},
        opponent={"hero": {"entity_id": 2},
                  "board": [{"entity_id": 20, "atk": 1, "health": 1,
                             "taunt": True, "divine_shield": True}]},
    )

    assert HeuristicAgent().choose_action(view, [end, attack]) == attack


def test_unknown_mixed_target_card_is_not_guessed_at():
    own = Action(type="PLAY_CARD", source_entity_id=11, target_entity_id=1)
    enemy = Action(type="PLAY_CARD", source_entity_id=11, target_entity_id=2)
    end = Action(type="END_TURN")
    view = observation(
        self_view={"hero": {"entity_id": 1}, "mana": 2,
                   "hand": [{"entity_id": 11, "card_id": "UNKNOWN", "cost": 2}]},
        opponent={"hero": {"entity_id": 2}},
    )

    assert HeuristicAgent().choose_action(view, [own, enemy, end]) == end


def test_buff_is_not_cast_on_the_only_available_enemy_target():
    buff_enemy = Action(type="PLAY_CARD", source_entity_id=11, target_entity_id=20)
    end = Action(type="END_TURN")
    view = observation(
        self_view={"hero": {"entity_id": 1}, "mana": 2,
                   "hand": [{"entity_id": 11, "card_id": "GIL_145", "cost": 2}]},
        opponent={"hero": {"entity_id": 2},
                  "board": [{"entity_id": 20, "atk": 3, "health": 3}]},
    )

    assert HeuristicAgent().choose_action(view, [buff_enemy, end]) == end


def test_zero_cost_echo_buff_does_not_repeat_forever():
    buff = Action(type="PLAY_CARD", source_entity_id=11, target_entity_id=10)
    end = Action(type="END_TURN")
    view = observation(
        self_view={"hero": {"entity_id": 1}, "mana": 0,
                   "board": [{"entity_id": 10, "atk": 1, "health": 1}],
                   "hand": [{"entity_id": 11, "card_id": "GIL_145", "cost": 0}]},
        opponent={"hero": {"entity_id": 2}},
    )

    assert HeuristicAgent().choose_action(view, [buff, end]) == end


def test_main_phase_uses_card_before_hero_power_and_hero_power_before_end():
    agent = HeuristicAgent()
    play = Action(type="PLAY_CARD", source_entity_id=11)
    power = Action(type="USE_HERO_POWER", source_entity_id=21)
    end = Action(type="END_TURN")
    view = observation(
        self_view={
            "mana": 2,
            "hero": {"entity_id": 1, "atk": 0},
            "board": [],
            "hand": [{"entity_id": 11, "cost": 2}],
            "hero_power": {"entity_id": 21, "cost": 2, "is_usable": True},
        },
        opponent={"hero": {"entity_id": 2, "health": 30, "armor": 0}, "board": []},
    )

    assert agent.choose_action(view, [end, power, play]) == play

    no_card_view = observation(
        self_view={
            "mana": 2,
            "hero": {"entity_id": 1, "atk": 0},
            "board": [],
            "hand": [],
            "hero_power": {"entity_id": 21, "cost": 2, "is_usable": True},
        },
        opponent={"hero": {"entity_id": 2, "health": 30, "armor": 0}, "board": []},
    )
    assert agent.choose_action(no_card_view, [end, power]) == power


def test_agent_is_deterministic_and_returns_one_of_the_supplied_actions():
    agent = HeuristicAgent()
    actions = [
        Action(type="PLAY_CARD", source_entity_id=11),
        Action(type="END_TURN"),
    ]
    view = observation(
        self_view={"mana": 1, "hand": [{"entity_id": 11, "cost": 1}]}
    )

    first = agent.choose_action(view, actions)
    second = agent.choose_action(view, actions)

    assert first == second
    assert first in actions


def test_agent_rejects_an_empty_legal_action_list():
    with pytest.raises(ValueError, match="no legal actions"):
        HeuristicAgent().choose_action(observation(), [])


def test_heuristic_agents_finish_a_fixed_deck_game():
    deck = ["CS2_231"] * 5
    first = Player("Heuristic One", deck[:], CardClass.DRUID.default_hero)
    second = Player("Heuristic Two", deck[:], CardClass.DRUID.default_hero)
    game = Game((first, second), seed=41)
    session = GameSession(
        game,
        {first: HeuristicAgent(), second: HeuristicAgent()},
    )

    result = session.run()

    assert result.ended
    assert result.turn > 0
