"""End-to-end checks for the local browser decision boundary."""

import json
import threading
from http.client import HTTPConnection
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import pytest
from hearthstone.enums import CardClass

from fireplace import cards
from fireplace.agents import RandomAgent
from fireplace.controller import GameSession
from fireplace.game import Game
from fireplace.player import Player
from fireplace.web_gui import server as web_server
from fireplace.web_gui.server import WebGame, make_server


cards.db.initialize()


@pytest.fixture
def web_game():
    servers = []

    def create(*, hero=CardClass.MAGE.default_hero, seed=3, asset_resolver=None, deck_size=10):
        human = Player("Human", ["CS2_231"] * deck_size, hero)
        opponent = Player("Computer", ["CS2_231"] * deck_size, hero)
        game = Game((human, opponent), seed=seed)
        app = WebGame(
            GameSession(game, {}), human, RandomAgent(seed=seed),
            asset_resolver=asset_resolver,
        )
        server = make_server(app, host="127.0.0.1", port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append((server, thread))
        return app, human, opponent, f"http://127.0.0.1:{server.server_port}"

    yield create
    for server, thread in servers:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def request(base, path="/api/state", payload=None, headers=None):
    data = None if payload is None else json.dumps(payload).encode()
    request_headers = {"Content-Type": "application/json"} if data is not None else {}
    request_headers.update(headers or {})
    req = Request(
        base + path,
        data=data,
        headers=request_headers,
    )
    try:
        with urlopen(req, timeout=10) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


def submit(base, state, action):
    return request(
        base, "/api/action", {"revision": state["revision"], "action": action}
    )


def action(state, kind, **fields):
    return next(
        item
        for item in state["legal_actions"]
        if item["type"] == kind and all(item.get(key) == value for key, value in fields.items())
    )


def ready(base):
    status, state = request(base)
    assert status == 200 and state["observation"]["phase"] == "MULLIGAN"
    status, state = submit(base, state, action(state, "MULLIGAN", mulligan_entity_ids=[]))
    assert status == 200 and state["observation"]["phase"] == "MAIN"
    return state


def test_branch_attack_and_end_turn(web_game):
    app, human, opponent, base = web_game()
    state = ready(base)
    human.max_mana = 10
    nourish = human.give("EX1_164")
    wisp = human.give("CS2_231")
    _, state = request(base)
    branches = [
        item for item in state["legal_actions"]
        if item["type"] == "PLAY_CARD" and item.get("source_entity_id") == nourish.entity_id
    ]
    assert len({item["choose_option_entity_id"] for item in branches}) == 2
    status, state = submit(base, state, branches[0])
    assert status == 200
    status, state = submit(
        base, state, action(state, "PLAY_CARD", source_entity_id=wisp.entity_id, position=0)
    )
    assert status == 200
    status, state = submit(base, state, action(state, "END_TURN"))
    assert status == 200
    assert state["observation"]["phase"] == "MAIN"
    attacks = [
        item for item in state["legal_actions"]
        if item["type"] == "ATTACK" and item["source_entity_id"] == wisp.entity_id
    ]
    assert attacks
    status, state = submit(base, state, attacks[0])
    assert status == 200


def test_real_snapshot_hides_opponent_hand_and_uses_placeholder(web_game, monkeypatch):
    monkeypatch.setattr(web_server, "_AssetResolver", None)
    app, human, opponent, base = web_game()
    status, state = request(base)
    assert status == 200
    view = state["observation"]
    assert view["self"]["hand"] and view["self"]["hero"]
    assert view["opponent"]["hero"] and "hand_count" in view["opponent"]
    assert "hand" not in view["opponent"]
    assert "secrets" not in view["opponent"]
    assert "pending_choice" not in view["opponent"]
    assert opponent.hand[0].entity_id not in [
        item["entity_id"] for item in view["self"]["hand"]
    ]
    assert view["phase"] == "MULLIGAN"
    with urlopen(base + "/", timeout=10) as response:
        assert response.status == 200
        html = response.read()
        assert b"app.js" in html
        assert b"opponent-mana-value" in html
    with urlopen(base + "/style.css", timeout=10) as response:
        assert b"placeholder" in response.read().lower()
    status, missing = request(base, "/assets/render/CS2_231")
    assert status == 404 and missing["error"]


def test_mulligan_ai_advance_and_stale_action(web_game):
    app, human, opponent, base = web_game()
    status, initial = request(base)
    assert status == 200
    assert any(a["mulligan_entity_ids"] for a in initial["legal_actions"])
    status, current = submit(base, initial, action(initial, "MULLIGAN", mulligan_entity_ids=[]))
    assert status == 200
    assert current["revision"] > initial["revision"]
    assert current["observation"]["phase"] == "MAIN"
    assert app.session.game.current_player is human
    assert len(app.session.action_log.to_dict()["actions"]) >= 2
    status, stale = submit(base, initial, action(initial, "MULLIGAN", mulligan_entity_ids=[]))
    assert status == 409 and stale["revision"] == current["revision"]
    assert stale["error"]
    status, malformed = request(base, "/api/action", {"revision": current["revision"], "action": {"type": "END_TURN"}})
    assert status == 400 and malformed["revision"] == current["revision"]


def test_cross_origin_and_non_json_actions_are_rejected(web_game):
    app, human, opponent, base = web_game()
    connection = HTTPConnection("127.0.0.1", urlsplit(base).port, timeout=10)
    connection.request("GET", "/api/state", headers={"Host": "attacker.example"})
    response = connection.getresponse()
    assert response.status == 403 and json.loads(response.read())["error"]
    connection.close()
    _, state = request(base)
    payload = {"revision": state["revision"], "action": action(state, "MULLIGAN", mulligan_entity_ids=[])}
    status, rejected = request(base, "/api/action", payload, {"Origin": "http://attacker.example"})
    assert status == 403 and rejected["revision"] == state["revision"]
    status, rejected = request(base, "/api/action", payload, {"Content-Type": "text/plain"})
    assert status == 415 and rejected["revision"] == state["revision"]
    status, accepted = request(base, "/api/action", payload, {"Origin": base})
    assert status == 200 and accepted["revision"] > state["revision"]


def test_optional_local_asset_contract_rejects_hidden_cards(web_game, tmp_path):
    image = tmp_path / "card.png"
    image.write_bytes(b"local-image")

    class Resolver:
        def describe(self, card_id):
            return SimpleNamespace(name=f"Local {card_id}", text="Local text", locale="enUS")

        def resolve(self, card_id, *, kind):
            return SimpleNamespace(path=image, media_type="image/png", locale="enUS", is_placeholder=False)

    app, human, opponent, base = web_game(asset_resolver=Resolver())
    ready(base)
    opponent.give("CS2_029")
    status, state = request(base)
    assert status == 200
    visible = state["observation"]["self"]["hand"][0]
    assert visible["name"].startswith("Local ")
    assert visible["text"] == "Local text"
    with urlopen(base + "/assets/render/" + visible["card_id"], timeout=10) as response:
        assert response.headers["Content-Type"] == "image/png"
        assert response.read() == b"local-image"
    status, _ = request(base, "/assets/render/CS2_029")
    assert status == 404


def test_discover_target_position_and_hero_power(web_game):
    app, human, opponent, base = web_game()
    state = ready(base)
    human.max_mana = 10
    first = human.give("CS2_231")
    second = human.give("CS2_231")
    fireball = human.give("CS2_029")
    curator = human.give("LOE_006")

    _, state = request(base)
    status, state = submit(
        base, state, action(state, "PLAY_CARD", source_entity_id=first.entity_id, position=0)
    )
    assert status == 200
    status, state = submit(
        base, state, action(state, "PLAY_CARD", source_entity_id=second.entity_id, position=0)
    )
    assert status == 200
    assert [card["entity_id"] for card in state["observation"]["self"]["board"]][:2] == [
        second.entity_id, first.entity_id
    ]
    status, state = submit(
        base,
        state,
        action(
            state,
            "PLAY_CARD",
            source_entity_id=fireball.entity_id,
            target_entity_id=opponent.hero.entity_id,
        ),
    )
    assert status == 200 and state["observation"]["opponent"]["hero"]["health"] == 24
    status, state = submit(
        base, state, action(state, "PLAY_CARD", source_entity_id=curator.entity_id)
    )
    assert status == 200 and state["observation"]["phase"] == "CHOICE"
    assert {item["type"] for item in state["legal_actions"]} == {"CHOOSE"}
    status, state = submit(base, state, action(state, "CHOOSE"))
    assert status == 200 and state["observation"]["phase"] == "MAIN"
    power = action(state, "USE_HERO_POWER", target_entity_id=opponent.hero.entity_id)
    status, state = submit(base, state, power)
    assert status == 200
    assert state["observation"]["opponent"]["hero"]["health"] == 23


def test_terminal_action_returns_outcome(web_game):
    app, human, opponent, base = web_game()
    state = ready(base)
    human.max_mana = 10
    opponent.hero.damage = opponent.hero.max_health - 1
    fireball = human.give("CS2_029")
    _, state = request(base)
    status, state = submit(
        base,
        state,
        action(
            state,
            "PLAY_CARD",
            source_entity_id=fireball.entity_id,
            target_entity_id=opponent.hero.entity_id,
        ),
    )
    assert status == 200
    assert state["observation"]["phase"] == "GAME_OVER"
    assert state["legal_actions"] == []
    assert state["outcome"] is not None


def test_complete_match_through_http_actions(web_game):
    app, human, opponent, base = web_game(deck_size=5)
    status, state = request(base)
    assert status == 200
    seen = set()
    for _ in range(300):
        if state["outcome"] is not None:
            break
        seen.add(state["observation"]["phase"])
        actions = state["legal_actions"]
        assert actions
        chosen = next((item for item in actions if item["type"] == "ATTACK" and item["target_entity_id"] == opponent.hero.entity_id), None)
        if chosen is None:
            chosen = next((item for item in actions if item["type"] == "PLAY_CARD"), None)
        if chosen is None:
            chosen = next((item for item in actions if item["type"] == "END_TURN"), actions[0])
        status, state = submit(base, state, chosen)
        assert status == 200
    assert state["outcome"] is not None
    assert state["observation"]["phase"] == "GAME_OVER"
    assert {"MULLIGAN", "MAIN"} <= seen
    assert state["legal_actions"] == []
