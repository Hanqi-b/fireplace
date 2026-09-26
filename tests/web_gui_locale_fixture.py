#!/usr/bin/env python3
"""Serve deterministic real matches with local, language-specific card assets."""

from __future__ import annotations

import argparse
import base64
import json
import os
import signal
import struct
import sys
import tempfile
import threading
import zlib
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fireplace import cards
from fireplace.game import Game
from fireplace.player import Player
from fireplace.web_gui import factory
from fireplace.web_gui.server import WebGame, WebGameManager, make_server


CARD_ID = "CS2_231"


def _png_pixel(red: int, green: int, blue: int) -> bytes:
    """Create a tiny valid RGBA PNG without a third-party imaging library."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    image_data = zlib.compress(bytes((0, red, green, blue, 255)))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", image_data)
        + chunk(b"IEND", b"")
    )


class LocaleResolver:
    """A local-only resolver that gives one visible card distinct locale data."""

    def __init__(self, cache_dir: Path):
        self._paths: dict[str, Path] = {}
        self._descriptions = {
            "zhCN": {"name": "测试小精灵", "text": "中文资源契约文本", "locale": "zhCN"},
            "enUS": {"name": "Fixture Wisp", "text": "English fixture text", "locale": "enUS"},
        }
        self._pngs = {
            "zhCN": _png_pixel(230, 70, 45),
            "enUS": _png_pixel(35, 105, 235),
        }
        for locale, data in self._pngs.items():
            path = cache_dir / (locale + ".png")
            path.write_bytes(data)
            self._paths[locale] = path

    def describe(self, card_id: str, *, locale: str = "zhCN") -> dict[str, str] | None:
        if card_id != CARD_ID:
            return None
        return dict(self._descriptions[locale])

    def resolve(
        self, card_id: str, *, kind: str = "render", locale: str = "zhCN"
    ) -> SimpleNamespace | None:
        if card_id != CARD_ID or kind != "render":
            return None
        return SimpleNamespace(
            path=self._paths[locale],
            media_type="image/png",
            locale=locale,
            is_placeholder=False,
        )

    def public_contract(self) -> dict[str, dict[str, str]]:
        return {
            locale: {
                **self._descriptions[locale],
                "png_base64": base64.b64encode(self._pngs[locale]).decode("ascii"),
            }
            for locale in ("zhCN", "enUS")
        }


class LocaleFixtureGame(WebGame):
    """Expose one Wisp and a deterministic Fireball lethal after Mulligan."""

    def __init__(self, *args, **kwargs):
        self._fixture_ready = False
        super().__init__(*args, **kwargs)

    def handle_action(self, payload: object) -> dict[str, object]:
        response = super().handle_action(payload)
        action = payload.get("action") if isinstance(payload, Mapping) else None
        if (
            not self._fixture_ready
            and isinstance(action, Mapping)
            and action.get("type") == "MULLIGAN"
            and response.get("outcome") is None
        ):
            with self.lock:
                human = self.human
                opponent = human.opponent
                human.max_mana = 10
                human.used_mana = 0
                opponent.hero.damage = opponent.hero.max_health - 6
                human.hand.clear()
                human.give(CARD_ID)
                human.give("CS2_029")
                self._fixture_ready = True
                self._revision += 1
                response = self.snapshot()
        return response


def _build_game(seed: int | None, opponent_name: str, nickname: str):
    cards.db.initialize()
    human = Player(nickname, [CARD_ID] * 30, "HERO_01")
    opponent = Player(opponent_name, [CARD_ID] * 30, "HERO_01")
    return Game((human, opponent), seed=seed), human, opponent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    cards.db.initialize()
    factory.build_game = _build_game
    from fireplace.web_gui import server as web_server

    web_server.WebGame = LocaleFixtureGame
    stop = threading.Event()
    with tempfile.TemporaryDirectory(prefix="fireplace-gui-locale-") as temporary:
        resolver = LocaleResolver(Path(temporary))
        manager = WebGameManager(seed=9301, opponent="heuristic", asset_resolver=resolver)
        server = make_server(manager, host="127.0.0.1", port=args.port)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        signal.signal(signal.SIGTERM, lambda *_args: stop.set())
        print(
            json.dumps({
                "url": f"http://127.0.0.1:{server.server_port}/",
                "contracts": resolver.public_contract(),
            }, ensure_ascii=False),
            flush=True,
        )
        try:
            stop.wait()
        except KeyboardInterrupt:
            pass
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
