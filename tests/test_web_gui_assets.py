"""Focused tests for asynchronous optional web GUI asset access."""

from __future__ import annotations

import io
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import card_assets
import pytest

from fireplace.web_gui.assets import AssetDescription, AssetPayload, AssetService


def _wait_for_description(service: AssetService, card_id: str) -> AssetDescription:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        found = service.describe_visible([card_id]).get(card_id)
        if found is not None:
            return found
        time.sleep(0.01)
    raise AssertionError(f"description was not cached for {card_id}")


def test_disabled_resolver_is_nonblocking_and_returns_no_asset():
    with AssetService(resolver=None) as service:
        assert service.describe_visible(["CS2_231"]) == {}
        future = service.request_asset("CS2_231")
        assert future.done()
        assert future.result() is None


def test_description_failure_is_cached_without_repeated_worker_submission():
    class BrokenResolver:
        def __init__(self):
            self.calls = 0

        def describe(self, card_id):
            self.calls += 1
            raise OSError("catalog unavailable")

    resolver = BrokenResolver()
    with AssetService(resolver=resolver) as service:
        assert service.describe_visible(["CS2_231"]) == {}
        # Wait until the first failed worker has marked the id negative.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and resolver.calls == 0:
            time.sleep(0.01)
        assert resolver.calls == 1
        for _ in range(10):
            assert service.describe_visible(["CS2_231"]) == {}
        time.sleep(0.02)
        assert resolver.calls == 1


def test_description_requests_for_one_card_share_inflight_work():
    started = threading.Event()
    release = threading.Event()
    calls = 0

    class BlockingResolver:
        def describe(self, card_id):
            nonlocal calls
            calls += 1
            started.set()
            assert release.wait(5)
            return SimpleNamespace(name="小精灵", text="", locale="zhCN")

    with AssetService(resolver=BlockingResolver()) as service:
        assert service.describe_visible(["CS2_231"]) == {}
        assert started.wait(5)
        assert service.describe_visible(["CS2_231", "CS2_231"]) == {}
        assert calls == 1
        release.set()
        assert _wait_for_description(service, "CS2_231").name == "小精灵"
        assert calls == 1


def test_real_resolver_returns_chinese_description_and_external_asset_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    image = card_assets.PLACEHOLDER_PATH.read_bytes()
    requested: list[str] = []

    def opener(url: str, *, timeout: float):
        requested.append(url)
        return io.BytesIO(image)

    monkeypatch.setattr(card_assets, "URL_OPENER", opener)
    cache_dir = tmp_path / "card-assets-cache"
    resolver = card_assets.AssetResolver(cache_dir=cache_dir)
    with AssetService(resolver=resolver) as service:
        description = _wait_for_description(service, "CS2_029")
        assert description.name == "火球术"
        assert description.text == "造成$6点伤害。"
        assert description.locale == "zhCN"

        payload = service.request_asset("CS2_029", "render").result(timeout=5)
        assert isinstance(payload, AssetPayload)
        assert payload.data == image
        assert payload.media_type == "image/png"
        assert payload.locale == "zhCN"
        assert payload.is_placeholder is False
    assert requested and "/zhCN/" in requested[0]
    assert list(cache_dir.iterdir())


def test_asset_requests_for_one_key_share_inflight_future(tmp_path: Path):
    started = threading.Event()
    release = threading.Event()
    calls = 0
    calls_lock = threading.Lock()
    image_path = tmp_path / "asset.png"
    image_path.write_bytes(b"asset-bytes")

    class BlockingResolver:
        def resolve(self, card_id, *, kind):
            nonlocal calls
            with calls_lock:
                calls += 1
            started.set()
            assert release.wait(5)
            return SimpleNamespace(
                path=image_path,
                media_type="image/png",
                locale="zhCN",
                is_placeholder=False,
            )

    with AssetService(resolver=BlockingResolver()) as service:
        first = service.request_asset("CS2_231", "render")
        assert started.wait(5)
        second = service.request_asset("CS2_231", "render")
        assert second is first
        release.set()
        payload = first.result(timeout=5)
        assert payload == AssetPayload(b"asset-bytes", "image/png", "zhCN", False)
        assert calls == 1

        # A ready real image is served from the bounded memory cache, so the
        # browser's retry after HTTP 202 does not start another resolution.
        third = service.request_asset("CS2_231", "render")
        assert third is not first
        assert third.result(timeout=5) == payload
        assert calls == 1


def test_resolver_exception_returns_none_and_does_not_leak_future():
    class BrokenResolver:
        def resolve(self, card_id, *, kind):
            raise RuntimeError("offline")

    with AssetService(resolver=BrokenResolver()) as service:
        assert service.request_asset("CS2_231").result(timeout=5) is None
        # A failed resolve is removed from the in-flight map and can be
        # retried without accumulating completed Future objects.
        assert service.request_asset("CS2_231").result(timeout=5) is None


def test_real_resolver_offline_uses_its_placeholder(tmp_path: Path, monkeypatch):
    def offline(url: str, *, timeout: float):
        raise OSError("offline")

    monkeypatch.setattr(card_assets, "URL_OPENER", offline)
    resolver = card_assets.AssetResolver(cache_dir=tmp_path / "outside-cache")
    with AssetService(resolver=resolver) as service:
        payload = service.request_asset("CS2_231", "render").result(timeout=10)
    assert isinstance(payload, AssetPayload)
    assert payload.is_placeholder is True
    assert payload.media_type == "image/png"
    assert payload.data == card_assets.PLACEHOLDER_PATH.read_bytes()
