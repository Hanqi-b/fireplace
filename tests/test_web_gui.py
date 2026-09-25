"""End-to-end checks for the local browser decision boundary."""

import json
import io
import threading
import time
from http.client import HTTPConnection
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import pytest
from hearthstone.enums import CardClass

import card_assets
from card_assets import AssetResolver
from fireplace import cards
from fireplace.agents import HeuristicAgent, RandomAgent
from fireplace.agent_api import Action
from fireplace.controller import GameSession
from fireplace.game import Game
from fireplace.player import Player
from fireplace.web_gui import server as web_server
from fireplace.web_gui.factory import build_game
from fireplace.web_gui.server import WebGame, make_server


cards.db.initialize()


@pytest.fixture
def web_game():
    servers = []

    def create(*, hero=CardClass.MAGE.default_hero, seed=3, asset_resolver=None,
               deck_size=10, opponent_policy="random"):
        human = Player("Human", ["CS2_231"] * deck_size, hero)
        opponent = Player("Computer", ["CS2_231"] * deck_size, hero)
        game = Game((human, opponent), seed=seed)
        app = WebGame(
            GameSession(game, {}), human,
            HeuristicAgent() if opponent_policy == "heuristic" else RandomAgent(seed=seed),
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
        base, "/api/action", {"session_id": state["session_id"], "revision": state["revision"], "action": action}
    )


def wait_asset(base, path, timeout=10):
    deadline = time.monotonic() + timeout
    while True:
        with urlopen(base + path, timeout=timeout) as response:
            status = response.status
            media_type = response.headers.get("Content-Type")
            data = response.read()
        if status != 202:
            return status, media_type, data
        if time.monotonic() >= deadline:
            raise AssertionError("asset never became ready")
        time.sleep(0.05)


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
    status, malformed = request(base, "/api/action", {"session_id": current["session_id"], "revision": current["revision"], "action": {"type": "END_TURN"}})
    assert status == 400 and malformed["revision"] == current["revision"]


def test_old_browser_session_rejected_even_at_matching_revision(web_game):
    _app, _human, _opponent, base = web_game()
    _, current = request(base)
    payload = {
        "session_id": "previous-server-session",
        "revision": current["revision"],
        "action": action(current, "MULLIGAN", mulligan_entity_ids=[]),
    }
    status, rejected = request(base, "/api/action", payload)
    assert status == 409
    assert rejected["session_id"] == current["session_id"]
    assert rejected["revision"] == current["revision"]
    _, unchanged = request(base)
    assert unchanged["revision"] == current["revision"]


def test_public_events_hide_opponent_private_decisions(web_game):
    app, human, opponent, base = web_game()
    state = ready(base)
    events = state["events"]
    assert events
    assert [event["seq"] for event in events] == sorted(event["seq"] for event in events)
    for event in events:
        assert set(event) <= {
            "seq", "turn", "actor", "type", "source_name", "target_name",
            "source_entity_id", "target_entity_id", "position",
        }
        if event["actor"] == "opponent" and event["type"] in {"MULLIGAN", "CHOOSE"}:
            assert "source_name" not in event
            assert "source_entity_id" not in event
    assert not any("mulligan_entity_ids" in event for event in events)
    assert "hand" not in state["observation"]["opponent"]

    status, next_state = submit(base, state, action(state, "END_TURN"))
    assert status == 200
    assert next_state["events"][-1]["seq"] > events[-1]["seq"]
    assert next_state["events"][-1]["actor"] in {"self", "opponent"}


def test_opponent_secret_stays_hidden_in_snapshot_log_and_assets(web_game):
    app, human, opponent, base = web_game()
    state = ready(base)
    secret = opponent.give("EX1_287")
    opponent.max_mana = 10

    class SecretAgent:
        def choose_action(self, observation, actions):
            play = next((item for item in actions if item.type == "PLAY_CARD"
                         and item.source_entity_id == secret.entity_id), None)
            return play or next(item for item in actions if item.type == "END_TURN")

    app.opponent_agent = SecretAgent()
    status, state = submit(base, state, action(state, "END_TURN"))
    assert status == 200
    assert state["observation"]["opponent"]["secrets_count"] == 1
    assert "secrets" not in state["observation"]["opponent"]
    assert "EX1_287" not in json.dumps(state)
    hidden_play = next(
        event for event in state["events"]
        if event["actor"] == "opponent" and event["type"] == "PLAY_CARD"
    )
    assert "source_name" not in hidden_play
    assert "source_entity_id" not in hidden_play
    status, missing = request(base, "/assets/render/EX1_287")
    assert status == 404


def test_cross_origin_and_non_json_actions_are_rejected(web_game):
    app, human, opponent, base = web_game()
    connection = HTTPConnection("127.0.0.1", urlsplit(base).port, timeout=10)
    connection.request("GET", "/api/state", headers={"Host": "attacker.example"})
    response = connection.getresponse()
    assert response.status == 403 and json.loads(response.read())["error"]
    connection.close()
    _, state = request(base)
    payload = {"session_id": state["session_id"], "revision": state["revision"], "action": action(state, "MULLIGAN", mulligan_entity_ids=[])}
    status, rejected = request(base, "/api/action", payload, {"Origin": "http://attacker.example"})
    assert status == 403 and rejected["revision"] == state["revision"]
    status, rejected = request(base, "/api/action", payload, {"Content-Type": "text/plain"})
    assert status == 415 and rejected["revision"] == state["revision"]
    status, accepted = request(base, "/api/action", payload, {"Origin": base})
    assert status == 200 and accepted["revision"] > state["revision"]


def test_server_refuses_nonlocal_bind(web_game):
    app, human, opponent, base = web_game()
    with pytest.raises(ValueError, match="loopback"):
        make_server(app, host="0.0.0.0", port=0)


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
    deadline = time.monotonic() + 5
    while True:
        status, state = request(base)
        assert status == 200
        visible = state["observation"]["self"]["hand"][0]
        if visible["name"].startswith("Local ") or time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    assert visible["name"].startswith("Local ")
    assert visible["text"] == "Local text"
    status, media_type, data = wait_asset(base, "/assets/render/" + visible["card_id"])
    assert status == 200 and media_type == "image/png" and data == b"local-image"
    status, _ = request(base, "/assets/render/CS2_029")
    assert status == 404


def test_real_resolver_chinese_text_and_external_cached_image(web_game, tmp_path, monkeypatch):
    image = card_assets.PLACEHOLDER_PATH.read_bytes()
    requested = []

    def opener(url, *, timeout):
        requested.append(url)
        return io.BytesIO(image)

    monkeypatch.setattr(card_assets, "URL_OPENER", opener)
    cache_dir = tmp_path / "outside-repository-cache"
    resolver = AssetResolver(cache_dir=cache_dir)
    _, human, opponent, base = web_game(asset_resolver=resolver)
    deadline = time.monotonic() + 5
    while True:
        status, state = request(base)
        assert status == 200
        own_card = state["observation"]["self"]["hand"][0]
        if own_card["name"] == "小精灵" or time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    assert own_card["card_id"] == "CS2_231"
    assert own_card["name"] == "小精灵"
    status, media_type, data = wait_asset(base, "/assets/render/CS2_231")
    assert status == 200 and media_type == "image/png" and data == image
    assert requested and "/zhCN/" in requested[0]
    assert any(cache_dir.iterdir())


def test_cold_image_request_does_not_block_state_or_decision(web_game, tmp_path):
    image = tmp_path / "card.png"
    image.write_bytes(card_assets.PLACEHOLDER_PATH.read_bytes())
    resolving = threading.Event()
    release = threading.Event()

    class SlowResolver:
        def describe(self, card_id):
            return None

        def resolve(self, card_id, *, kind):
            resolving.set()
            assert release.wait(timeout=10)
            return SimpleNamespace(
                path=image, media_type="image/png", locale="zhCN", is_placeholder=False
            )

    _, human, opponent, base = web_game(asset_resolver=SlowResolver())
    state = ready(base)
    card_id = state["observation"]["self"]["hand"][0]["card_id"]
    with urlopen(base + "/assets/render/" + card_id, timeout=3) as response:
        assert response.status == 202
        assert response.read() == b""
    try:
        assert resolving.wait(timeout=3)
        with urlopen(base + "/api/state", timeout=3) as response:
            assert json.load(response)["revision"] == state["revision"]
        payload = {"session_id": state["session_id"], "revision": state["revision"], "action": action(state, "END_TURN")}
        req = Request(
            base + "/api/action", data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urlopen(req, timeout=3) as response:
            assert json.load(response)["revision"] > state["revision"]
    finally:
        release.set()
    status, media_type, data = wait_asset(base, "/assets/render/" + card_id)
    assert status == 200 and data == image.read_bytes()


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
    human.name = "Alice"
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
    assert state["outcome"] == {"winner": "Alice", "human_won": True}


@pytest.mark.parametrize("opponent_policy", ["random", "heuristic"])
def test_complete_match_through_http_actions(web_game, opponent_policy):
    app, human, opponent, base = web_game(deck_size=5, opponent_policy=opponent_policy)
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


@pytest.mark.parametrize("opponent_policy", ["random", "heuristic"])
def test_real_draft_reaches_game_over_through_value_actions(monkeypatch, opponent_policy):
    monkeypatch.setattr(web_server, "_AssetResolver", None)
    game, human, opponent = build_game(seed=2, opponent_name=opponent_policy)
    ai = HeuristicAgent() if opponent_policy == "heuristic" else RandomAgent(seed=2)
    human_agent = HeuristicAgent()
    app = WebGame(GameSession(game, {}), human, ai)
    try:
        state = app.snapshot()
        seen = set()
        for _ in range(500):
            if state["outcome"] is not None:
                break
            seen.add(state["observation"]["phase"])
            actions = [Action.from_dict(item) for item in state["legal_actions"]]
            assert actions
            chosen = human_agent.choose_action(state["observation"], actions)
            assert chosen in actions
            state = app.handle_action(
                {"session_id": state["session_id"], "revision": state["revision"], "action": chosen.to_dict()}
            )
        assert state["outcome"] is not None
        assert state["observation"]["phase"] == "GAME_OVER"
        assert {"MULLIGAN", "MAIN", "CHOICE"} <= seen
        assert len(state["events"]) == len(app.session.action_log.to_dict()["actions"])
        assert len(state["events"]) > 40
    finally:
        app.close()
