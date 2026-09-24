from __future__ import annotations

import os.path
from bisect import bisect
from importlib import import_module
from pkgutil import iter_modules
from typing import List, TypeVar, overload
from xml.etree import ElementTree

from hearthstone.enums import CardClass, CardType

from .logging import log
from .entity import Entity


# Autogenerate the list of cardset modules
_cards_module = os.path.join(os.path.dirname(__file__), "cards")
CARD_SETS = [cs for _, cs, ispkg in iter_modules([_cards_module]) if ispkg]
T = TypeVar("T")


class CardList(list[T], Entity):
    def __contains__(self, x: T) -> bool:
        for item in self:
            if x is item:
                return True
        return False

    @overload
    def __getitem__(self, index: int) -> T:
        pass

    @overload
    def __getitem__(self, index: slice) -> CardList[T]:
        pass

    def __getitem__(self, key):
        ret = super().__getitem__(key)
        if isinstance(key, slice):
            return self.__class__(ret)
        return ret

    def __int__(self) -> int:
        # Used in Kettle to easily serialize CardList to json
        return len(self)

    def contains(self, x: T | str) -> bool:
        """
        True if list contains any instance of x
        """
        for item in self:
            if x == item:
                return True
        return False

    def index(self, x: T) -> int:
        for i, item in enumerate(self):
            if x is item:
                return i
        raise ValueError

    def remove(self, x: T):
        for i, item in enumerate(self):
            if x is item:
                del self[i]
                return
        raise ValueError

    def exclude(self, *args, **kwargs):
        if args:
            return self.__class__(e for e in self for arg in args if e is not arg)
        else:
            return self.__class__(
                e for k, v in kwargs.items() for e in self if getattr(e, k) != v
            )

    def filter(self, **kwargs):
        def conditional(e, k, v):
            p = getattr(e, k, 0)
            if hasattr(p, "__iter__"):
                return v in p
            return p == v

        return self.__class__(
            e for k, v in kwargs.items() for e in self if conditional(e, k, v)
        )


def random_draft(card_class: CardClass, exclude=[], include=[], game=None):
    """
    Return a deck of 30 random cards for the \a card_class
    """
    import random
    from . import cards
    from .deck import Deck

    deck = list(include)
    collection = []
    # hero = card_class.default_hero

    for card in cards.db.keys():
        if card in exclude:
            continue
        cls = cards.db[card]
        if not cls.collectible:
            continue
        if cls.type == CardType.HERO:
            # Heroes are collectible...
            continue
        if cls.card_class and cls.card_class not in [card_class, CardClass.NEUTRAL]:
            # Play with more possibilities
            continue
        collection.append(cls)

    while len(deck) < Deck.MAX_CARDS:
        if game:
            card = game.random.choice(collection)
        else:
            card = random.choice(collection)
        if deck.count(card.id) < card.max_count_in_deck:
            deck.append(card.id)

    return deck


def random_class(game=None):
    if game:
        return CardClass(game.random.randint(2, 10))
    import random

    return CardClass(random.randint(2, 10))


def entity_to_xml(entity):
    e = ElementTree.Element("Entity")
    for tag, value in entity.tags.items():
        if value and not isinstance(value, str):
            te = ElementTree.Element("Tag")
            te.attrib["enumID"] = str(int(tag))
            te.attrib["value"] = str(int(value))
            e.append(te)
    return e


def game_state_to_xml(game):
    tree = ElementTree.Element("HSGameState")
    tree.append(entity_to_xml(game))
    for player in game.players:
        tree.append(entity_to_xml(player))
    for entity in game:
        if entity.type in (CardType.GAME, CardType.PLAYER):
            # Serialized those above
            continue
        e = entity_to_xml(entity)
        e.attrib["CardID"] = entity.id
        tree.append(e)

    return ElementTree.tostring(tree)


def weighted_card_choice(source, weights: List[int], card_sets: List[str], count: int):
    """
    Take a list of weights and a list of card pools and produce
    a random weighted sample without replacement.
    len(weights) == len(card_sets) (one weight per card set)
    """

    chosen_cards = []

    # sum all the weights
    cum_weights = []
    totalweight = 0
    for i, w in enumerate(weights):
        totalweight += w * len(card_sets[i])
        cum_weights.append(totalweight)

    if totalweight == 0:
        return []

    # for each card
    for i in range(count):
        # choose a set according to weighting
        chosen_set = bisect(cum_weights, source.game.random.random() * totalweight)

        # choose a random card from that set
        chosen_card_index = source.game.random.randint(
            0, len(card_sets[chosen_set]) - 1
        )

        chosen_cards.append(card_sets[chosen_set].pop(chosen_card_index))
        totalweight -= weights[chosen_set]
        cum_weights[chosen_set:] = [
            x - weights[chosen_set] for x in cum_weights[chosen_set:]
        ]

    return [source.controller.card(card, source=source) for card in chosen_cards]


def setup_game(seed=None, start=True):
    from .game import Game
    from .player import Player

    # Create the game first so every setup decision comes from the same
    # per-game RNG that the engine uses after startup.
    game = Game(seed=seed)
    card_class1 = random_class(game)
    card_class2 = random_class(game)
    deck1 = random_draft(card_class1, game=game)
    deck2 = random_draft(card_class2, game=game)
    player1 = Player("Player1", deck1, card_class1.default_hero)
    player2 = Player("Player2", deck2, card_class2.default_hero)

    game.players = (player1, player2)
    for player in game.players:
        player.game = game
    if start:
        game.start()

    return game


def play_turn(game):
    # Keep the old batch-simulation entry point, but make its decisions cross
    # the same validated boundary used by the interactive application.
    from .agents import RandomAgent
    from .controller import GameSession, decision_player

    session = getattr(game, "_random_session", None)
    if session is None:
        # Keep policy choices on their own stream.  Replaying recorded
        # actions skips those policy draws, so sharing ``game.random`` would
        # shift every later engine decision.
        agent = RandomAgent(seed=getattr(game, "seed", None))
        session = GameSession(game, {player: agent for player in game.players})
        game._random_session = session

    starting_player = game.current_player
    while game.current_player is starting_player or any(
        player.choice for player in game.players
    ):
        player = decision_player(game)
        action = session.agents[player].choose_action(
            session.observation(player), session.legal_actions(player)
        )
        session.execute(player, action)
    return game


def play_full_game(seed=None, action_log=None):
    from .agents import RandomAgent
    from .action_log import ActionLog
    from .controller import GameSession, decision_player

    game = setup_game(seed=seed, start=False)
    # The game RNG is reserved for setup and engine effects.  The policy gets
    # a separate deterministic stream when a seed was supplied.
    agent = RandomAgent(seed=seed)
    if action_log is None:
        action_log = ActionLog(game, seed=seed)
    elif isinstance(action_log, (str, os.PathLike)):
        action_log = ActionLog(game, output_path=action_log, seed=seed)
    session = GameSession(
        game, {player: agent for player in game.players}, action_log=action_log
    )
    game._random_session = session
    session.start()
    while any(player.choice for player in game.players):
        player = decision_player(game)
        action = agent.choose_action(
            session.observation(player), session.legal_actions(player)
        )
        session.execute(player, action)

    while True:
        play_turn(game)

    return game
