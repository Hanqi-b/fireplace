"""Player-decision boundary for a Fireplace game.

The engine still owns every rule and effect.  This module only exposes the
decisions a player can make in the *current* phase and translates a selected
decision back to the checked engine API.
"""

from itertools import combinations

from hearthstone.enums import CardType, State

from .actions import MulliganChoice
from .agent_api import Action
from .action_log import ActionLog
from .exceptions import GameOver, InvalidAction
from .managers import BaseObserver
from .observation import build_observation


class ActionError(ValueError):
    """An action is stale or is not available to this player now."""


class EntityIndex(BaseObserver):
    """Keep this game's entity handles available without exposing entities to agents."""

    def __init__(self, game):
        self.entities = {game.entity_id: game}
        game.manager.register(self)
        # Also support attaching to a game that has already started.
        for entity in game:
            self.new_entity(entity)
        for player in game.players:
            if player.choice:
                for card in player.choice.cards:
                    self.new_entity(card)
            for card in player.hand:
                for branch in card.choose_cards:
                    self.new_entity(branch)

    def new_entity(self, entity):
        entity_id = getattr(entity, "entity_id", None)
        if entity_id is not None:
            self.entities[entity_id] = entity

    def get(self, entity_id):
        try:
            return self.entities[entity_id]
        except KeyError as exc:
            raise ActionError("Unknown entity ID: %s" % entity_id) from exc


def phase_for(game, player):
    """Return this player's phase, or None when another player must decide."""
    if game.ended:
        return "GAME_OVER"
    mulligans = [p for p in game.players if isinstance(p.choice, MulliganChoice)]
    if mulligans:
        return "MULLIGAN" if player in mulligans else None
    choices = [p for p in game.players if p.choice]
    if choices:
        return "CHOICE" if player in choices else None
    if game.current_player is player:
        return "MAIN"
    return None


def decision_player(game):
    """Choose the next player whose decision blocks the game."""
    if game.ended:
        return None
    for player in game.players:
        if isinstance(player.choice, MulliganChoice):
            return player
    for player in game.players:
        if player.choice:
            return player
    return game.current_player


def _targeted_actions(action_type, source, branch, position=None):
    base = {"type": action_type, "source_entity_id": source.entity_id}
    if branch is not source:
        base["choose_option_entity_id"] = branch.entity_id
    if position is not None:
        base["position"] = position
    if branch.requires_target():
        for target in branch.play_targets:
            yield Action(target_entity_id=target.entity_id, **base)
    else:
        yield Action(**base)


def legal_actions(game, player):
    """Read only: enumerate current decisions for ``player``."""
    phase = phase_for(game, player)
    if phase is None or phase == "GAME_OVER":
        return []
    if phase == "MULLIGAN":
        cards = player.choice.cards
        ids = [card.entity_id for card in cards]
        return [
            Action(type="MULLIGAN", mulligan_entity_ids=chosen)
            for count in range(len(ids) + 1)
            for chosen in combinations(ids, count)
        ]
    if phase == "CHOICE":
        return [Action(type="CHOOSE", choice_entity_id=card.entity_id)
                for card in player.choice.cards]

    actions = []
    for card in player.hand:
        if not card.is_playable():
            continue
        branches = card.choose_cards if card.must_choose_one else (card,)
        for branch in branches:
            if branch is not card and not branch.is_playable():
                continue
            positions = range(len(player.field) + 1) if card.type == CardType.MINION else (None,)
            for position in positions:
                actions.extend(_targeted_actions("PLAY_CARD", card, branch, position))

    for character in player.characters:
        if character.can_attack():
            for target in character.attack_targets:
                actions.append(Action(type="ATTACK", source_entity_id=character.entity_id,
                                      target_entity_id=target.entity_id))

    power = player.hero.power if player.hero else None
    if power and power.is_usable():
        branches = power.choose_cards if power.must_choose_one else (power,)
        for branch in branches:
            if branch is power or branch.is_playable():
                actions.extend(_targeted_actions("USE_HERO_POWER", power, branch))

    actions.append(Action(type="END_TURN"))
    return actions


def execute_action(game, player, action, index):
    """Revalidate a value action, resolve IDs, and call one checked engine API."""
    if not isinstance(action, Action):
        raise ActionError("Expected an Action value")
    if action not in legal_actions(game, player):
        raise ActionError("Action is unavailable or stale in the current phase")
    try:
        if action.type == "MULLIGAN":
            player.choice.choose(*(index.get(i) for i in action.mulligan_entity_ids))
        elif action.type == "CHOOSE":
            player.choice.choose(index.get(action.choice_entity_id))
        elif action.type == "PLAY_CARD":
            source = index.get(action.source_entity_id)
            target = index.get(action.target_entity_id) if action.target_entity_id else None
            branch = index.get(action.choose_option_entity_id) if action.choose_option_entity_id else None
            source.play(target=target, index=action.position, choose=branch)
        elif action.type == "ATTACK":
            index.get(action.source_entity_id).attack(index.get(action.target_entity_id))
        elif action.type == "USE_HERO_POWER":
            source = index.get(action.source_entity_id)
            target = index.get(action.target_entity_id) if action.target_entity_id else None
            branch = index.get(action.choose_option_entity_id) if action.choose_option_entity_id else None
            source.use(target=target, choose=branch)
        elif action.type == "END_TURN":
            game.end_turn()
    except InvalidAction as exc:
        raise ActionError(str(exc)) from exc


class GameSession:
    """Route each phase to the corresponding agent until Fireplace ends the game."""

    def __init__(self, game, agents, *, action_log=None):
        self.game = game
        self.agents = agents
        self.index = EntityIndex(game)
        self.action_log = action_log if action_log is not None else ActionLog(game)
        if game.state != State.INVALID:
            self.action_log.started(game)

    def start(self):
        if self.game.state == State.INVALID:
            self.action_log.before_start(self.game)
            self.game.start()
            self.action_log.started(self.game)

    def legal_actions(self, player):
        return legal_actions(self.game, player)

    def observation(self, player):
        return build_observation(self.game, player, phase_for(self.game, player))

    def execute(self, player, action):
        phase = phase_for(self.game, player)
        turn = self.game.turn
        try:
            result = execute_action(self.game, player, action, self.index)
        except GameOver:
            # Fireplace raises GameOver after applying the terminal decision.
            # It is still an accepted player input and belongs in the log.
            self.action_log.record(self.game, player, phase, action, turn=turn)
            self.action_log.finish(self.game)
            raise
        self.action_log.record(self.game, player, phase, action, turn=turn)
        if self.game.ended:
            self.action_log.finish(self.game)
        return result

    def run(self):
        self.start()
        while not self.game.ended:
            player = decision_player(self.game)
            if player is None:
                raise RuntimeError("Game has no player who can act")
            actions = self.legal_actions(player)
            if not actions:
                raise RuntimeError("No legal decision for %s" % player.name)
            agent = self.agents[player]
            action = agent.choose_action(self.observation(player), actions)
            try:
                self.execute(player, action)
            except ActionError as exc:
                # An interactive agent can display the reason and select
                # again from a fresh observation. Automated agent bugs remain
                # visible rather than being silently replaced with a move.
                report_error = getattr(agent, "on_action_error", None)
                if report_error is None:
                    raise
                report_error(str(exc))
                continue
            except GameOver:
                break
        return self.game
