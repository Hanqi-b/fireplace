"""Game construction shared by the installed web GUI and source example."""

from __future__ import annotations

from fireplace import cards
from fireplace.game import Game
from fireplace.player import Player
from fireplace.utils import random_class, random_draft


def build_game(
    seed: int | None = None,
    opponent_name: str = "Heuristic",
    nickname: str = "Human",
) -> tuple[Game, Player, Player]:
    """Create the same seeded random match used by the terminal example.

    The web GUI must also work from an installed wheel, where the repository's
    ``examples`` directory is not available.  Keeping this small factory in
    the package preserves the existing game setup without importing example
    modules from an installed application.
    """

    cards.db.initialize()

    # Empty decks are placeholders while Game owns the seeded RNG.  They are
    # filled before GameSession.start() calls game.start().
    human = Player(nickname, [], "HERO_01")
    opponent = Player(opponent_name, [], "HERO_01")
    game = Game((human, opponent), seed=seed)

    human_class = random_class(game)
    opponent_class = random_class(game)
    human.starting_hero = human_class.default_hero
    opponent.starting_hero = opponent_class.default_hero
    human.starting_deck = random_draft(human_class, game=game)
    opponent.starting_deck = random_draft(opponent_class, game=game)
    return game, human, opponent


__all__ = ["build_game"]
