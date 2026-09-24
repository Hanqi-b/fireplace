#!/usr/bin/env python3
"""Replay and verify a complete Fireplace decision log."""

from __future__ import annotations

import argparse
import logging
import os
import sys

if __package__ in (None, ""):
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fireplace.replay import ReplayError, replay_action_log


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", help="JSON action log written before game start")
    args = parser.parse_args(argv)
    logging.disable(logging.INFO)
    try:
        game = replay_action_log(args.log)
    except ReplayError as exc:
        parser.exit(1, "Replay failed: %s\n" % exc)
    winners = [player.name for player in game.players if player.playstate.name == "WON"]
    print("Replay verified: turn %s; winner: %s" % (game.turn, ", ".join(winners) or "tie"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
