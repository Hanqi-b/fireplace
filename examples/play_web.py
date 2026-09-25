#!/usr/bin/env python3
"""Play one Fireplace game in a browser on this computer.

Run from the repository root with ``python3 examples/play_web.py``.
"""

from __future__ import annotations

import argparse
import os
import sys

if __package__ in (None, ""):
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fireplace import cards
from fireplace.agents import HeuristicAgent, RandomAgent
from fireplace.controller import GameSession
from fireplace.web_gui.server import WebGame, make_server

from human_vs_random import build_game


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=None, help="seed the game RNG")
    parser.add_argument(
        "--opponent", choices=("random", "heuristic"), default="random"
    )
    parser.add_argument("--port", type=int, default=8765, help="local HTTP port")
    args = parser.parse_args(argv)

    cards.db.initialize()
    opponent_name = "Heuristic" if args.opponent == "heuristic" else "Random"
    game, human, _ = build_game(args.seed, opponent_name)
    agent = (
        HeuristicAgent()
        if args.opponent == "heuristic"
        else RandomAgent(seed=args.seed)
    )
    web_game = WebGame(GameSession(game, {}), human, agent)
    server = make_server(web_game, host="127.0.0.1", port=args.port)
    print(f"Open http://127.0.0.1:{server.server_port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
