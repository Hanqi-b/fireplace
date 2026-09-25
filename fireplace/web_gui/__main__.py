"""Run a local single-player Fireplace game in a browser.

The entry point is intentionally local-only: it binds to loopback and serves
one human-vs-agent session through the standard-library HTTP server.
"""

from __future__ import annotations

import argparse

from fireplace.agents import HeuristicAgent, RandomAgent
from fireplace.controller import GameSession

from .factory import build_game
from .server import WebGame, make_server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=None, help="seed the game RNG")
    parser.add_argument(
        "--opponent",
        choices=("random", "heuristic"),
        default="random",
        help="computer opponent policy (default: random)",
    )
    parser.add_argument("--port", type=int, default=8765, help="local HTTP port")
    args = parser.parse_args(argv)

    opponent_name = "Heuristic" if args.opponent == "heuristic" else "Random"
    game, human, _opponent = build_game(args.seed, opponent_name)
    opponent_agent = (
        HeuristicAgent()
        if args.opponent == "heuristic"
        else RandomAgent(seed=args.seed)
    )
    web_game = WebGame(GameSession(game, {}), human, opponent_agent)
    # Deliberately use the fixed loopback address.  This tool is a local
    # browser UI and must not expose a live game on the network.
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


__all__ = ["main"]
