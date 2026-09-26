#!/usr/bin/env python3
"""Play a Fireplace game against a computer agent in the terminal.

Run from the repository root with ``python examples/human_vs_heuristic.py``.
The example intentionally constructs the game here so the application layer
can be tried without changing the engine's existing batch simulation helper.
"""

from __future__ import annotations

import argparse
import os
import sys

# Make direct execution from a source checkout work before importing the local
# package.  Installed users can run the same module without this branch having
# any effect.
if __package__ in (None, ""):
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from hearthstone.enums import PlayState

from fireplace import cards
from fireplace.action_log import ActionLog
from fireplace.agents import HeuristicAgent, HumanTUIAgent, UserQuit
from fireplace.controller import GameSession
from fireplace.game import Game
from fireplace.player import Player
from fireplace.utils import random_class, random_draft


def build_game(
    seed: int | None = None, opponent_name: str = "Heuristic"
) -> tuple[Game, Player, Player]:
    """Create two random classes/decks using the game's seeded RNG."""

    # Empty starting decks are only placeholders while the Game owns the RNG;
    # they are filled before ``GameSession.start`` calls ``game.start()``.
    human = Player("Human", [], "HERO_01")
    opponent = Player(opponent_name, [], "HERO_01")
    game = Game((human, opponent), seed=seed)

    human_class = random_class(game)
    opponent_class = random_class(game)
    human.starting_hero = human_class.default_hero
    opponent.starting_hero = opponent_class.default_hero
    human.starting_deck = random_draft(human_class, game=game)
    opponent.starting_deck = random_draft(opponent_class, game=game)
    return game, human, opponent


def _winner_text(game: Game) -> str:
    winners = [
        player.name for player in game.players if player.playstate == PlayState.WON
    ]
    if winners:
        return ", ".join(winners)
    if all(player.playstate == PlayState.TIED for player in game.players):
        return "Tie"
    return "No winner recorded"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="seed the game RNG used for classes, decks, and game setup",
    )
    parser.add_argument(
        "--log",
        metavar="PATH",
        help="save accepted player decisions and game metadata as JSON",
    )
    args = parser.parse_args(argv)

    cards.db.initialize()
    opponent_name = "Heuristic"
    game, human, opponent = build_game(args.seed, opponent_name)
    opponent_agent = HeuristicAgent()
    agents = {human: HumanTUIAgent(), opponent: opponent_agent}
    action_log = ActionLog(
        game,
        mode="human_vs_heuristic",
        output_path=args.log,
        seed=args.seed,
    )

    print(
        "Human (%s) vs %s (%s). Choose an action number when it is your turn."
        % (human.starting_hero, opponent_name, opponent.starting_hero)
    )
    try:
        GameSession(game, agents, action_log=action_log).run()
    except (UserQuit, EOFError):
        action_log.finish(game, status="abandoned")
        print("Session closed.")
        return 0
    print("Game over. Winner: %s" % _winner_text(game))
    if args.log:
        print("Action log saved to %s" % args.log)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
