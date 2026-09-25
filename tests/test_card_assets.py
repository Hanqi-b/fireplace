"""Offline tests for the public card asset resolver API."""

from __future__ import annotations

import base64
import email.message
import http.client
import io
import socket
import struct
import zlib
from urllib.error import HTTPError

import pytest

import card_assets
from card_assets import AssetResolver


CARD_DEFS = """\
<?xml version="1.0" encoding="UTF-8"?>
<CardDefs>
  <Entity CardID="DEMO_001" ID="1">
    <Tag name="CARDNAME" type="LocString">
      <enUS>Sample Card</enUS>
      <zhCN>示例卡</zhCN>
    </Tag>
    <Tag name="CARDTEXT" type="LocString">
      <enUS>Summon a minion.</enUS>
      <zhCN>召唤一个随从。</zhCN>
    </Tag>
  </Entity>
  <Entity CardID="DEMO_002" ID="2">
    <Tag name="CARDNAME" type="LocString">
      <enUS>English Fallback</enUS>
    </Tag>
    <Tag name="CARDTEXT" type="LocString">
      <enUS>Fallback text.</enUS>
    </Tag>
  </Entity>
  <Entity CardID="DEMO_003" ID="3">
    <Tag name="CARDTEXT" type="LocString">
      <enUS>Unnamed card text.</enUS>
    </Tag>
  </Entity>
</CardDefs>
"""


def _png_bytes() -> bytes:
    """Build a tiny valid RGBA PNG without adding an imaging dependency."""

    def chunk(kind: bytes, payload: bytes) -> bytes:
        content = kind + payload
        return (
            struct.pack(">I", len(payload))
            + content
            + struct.pack(">I", zlib.crc32(content) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    pixels = zlib.compress(b"\x00\xff\x00\x00\xff")
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", pixels)
        + chunk(b"IEND", b"")
    )


def _jpeg_bytes() -> bytes:
    """A decodable 1x1 JPEG fixture, embedded so tests need no image library."""
    return base64.b64decode(
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD1CiiigD//2Q=="
    )


class _Response:
    def __init__(self, body: bytes, content_type: str = "image/png") -> None:
        self._body = body
        self.headers = email.message.Message()
        self.headers["Content-Type"] = content_type
        self.status = 200
        self.code = 200

    def read(self, *_args: object) -> bytes:
        return self._body

    def getcode(self) -> int:
        return self.status

    def getheader(self, name: str, default: object = None) -> object:
        return self.headers.get(name, default)

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


def _url_of(request: object) -> str:
    return str(getattr(request, "full_url", request))


def _image_response(url: str) -> _Response:
    if url.lower().endswith((".jpg", ".jpeg")):
        return _Response(_jpeg_bytes(), "image/jpeg")
    return _Response(_png_bytes(), "image/png")


def _not_found(url: str) -> HTTPError:
    return HTTPError(url, 404, "Not Found", email.message.Message(), io.BytesIO())


@pytest.fixture
def card_defs_path(tmp_path, monkeypatch):
    path = tmp_path / "CardDefs.xml"
    path.write_text(CARD_DEFS, encoding="utf-8")
    monkeypatch.setattr(card_assets, "CARD_DEFS_PATH", path)
    return path


def test_describe_reads_chinese_name_and_text_from_local_carddefs(
    card_defs_path, tmp_path
):
    description = AssetResolver(cache_dir=tmp_path / "cache").describe("DEMO_001")

    assert description.name == "示例卡"
    assert description.text == "召唤一个随从。"
    assert description.locale == "zhCN"


def test_describe_falls_back_to_english_and_card_id(card_defs_path, tmp_path):
    resolver = AssetResolver(cache_dir=tmp_path / "cache")

    english = resolver.describe("DEMO_002")
    assert english.name == "English Fallback"
    assert english.text == "Fallback text."
    assert english.locale == "enUS"

    unnamed = resolver.describe("DEMO_003")
    assert unnamed.name == "DEMO_003"
    assert unnamed.locale == "und"


def test_render_tries_zhcn_then_enus_before_using_download(tmp_path, monkeypatch):
    requested = []

    def fake_urlopen(request, timeout=None):
        url = _url_of(request)
        requested.append((url, timeout))
        if "/zhCN/" in url:
            raise _not_found(url)
        return _Response(_png_bytes())

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    result = AssetResolver(cache_dir=tmp_path / "cache").resolve(
        "DEMO_001", kind="render"
    )

    assert [url for url, _ in requested] == [
        "https://art.hearthstonejson.com/v1/render/latest/zhCN/256x/DEMO_001.png",
        "https://art.hearthstonejson.com/v1/render/latest/enUS/256x/DEMO_001.png",
    ]
    assert result.path.is_file()
    assert result.path.read_bytes() == _png_bytes()
    assert result.media_type == "image/png"
    assert result.locale == "enUS"
    assert result.is_placeholder is False


def test_render_uses_placeholder_after_both_locales_fail_and_remembers_404s(
    tmp_path, monkeypatch
):
    requested = []

    def fake_urlopen(request, timeout=None):
        url = _url_of(request)
        requested.append(url)
        raise _not_found(url)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    resolver = AssetResolver(cache_dir=tmp_path / "cache")

    first = resolver.resolve("DEMO_001", kind="render")
    assert first.path.is_file()
    assert first.media_type == "image/png"
    assert first.locale is None
    assert first.is_placeholder is True
    assert len(requested) == 2

    again = resolver.resolve("DEMO_001", kind="render")
    assert again.path == first.path
    assert len(requested) == 2


def test_render_skips_invalid_image_response_and_uses_next_locale(
    tmp_path, monkeypatch
):
    requested = []

    def fake_urlopen(request, timeout=None):
        url = _url_of(request)
        requested.append(url)
        if "/zhCN/" in url:
            return _Response(b"<html>not an image</html>", "text/html")
        return _Response(_png_bytes())

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    result = AssetResolver(cache_dir=tmp_path / "cache").resolve(
        "DEMO_001", kind="render"
    )

    assert len(requested) == 2
    assert "/zhCN/" in requested[0]
    assert "/enUS/" in requested[1]
    assert result.locale == "enUS"
    assert result.is_placeholder is False
    assert result.path.read_bytes() == _png_bytes()


def test_render_rejects_png_without_image_data(tmp_path, monkeypatch):
    requested = []
    valid = _png_bytes()
    idat_start = valid.index(b"IDAT") - 4
    iend_start = valid.index(b"IEND") - 4
    missing_pixels = valid[:idat_start] + valid[iend_start:]

    def fake_urlopen(request, timeout=None):
        requested.append(_url_of(request))
        return _Response(missing_pixels)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    result = AssetResolver(cache_dir=tmp_path / "cache").resolve("DEMO_001")

    assert result.is_placeholder is True
    assert len(requested) == 2


def test_cached_english_render_skips_later_chinese_timeout(tmp_path, monkeypatch):
    requested = []

    def fake_urlopen(request, timeout=None):
        url = _url_of(request)
        requested.append(url)
        if "/zhCN/" in url:
            raise socket.timeout("simulated timeout")
        return _Response(_png_bytes())

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    resolver = AssetResolver(cache_dir=tmp_path / "cache")
    first = resolver.resolve("DEMO_001")
    again = resolver.resolve("DEMO_001")

    assert first.locale == again.locale == "enUS"
    assert first.path == again.path
    assert len(requested) == 2


def test_art_and_tile_use_language_neutral_urls(tmp_path, monkeypatch):
    requested = []

    def fake_urlopen(request, timeout=None):
        url = _url_of(request)
        requested.append(url)
        return _image_response(url)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    resolver = AssetResolver(cache_dir=tmp_path / "cache")

    art = resolver.resolve("DEMO_001", kind="art")
    tile = resolver.resolve("DEMO_001", kind="tile")

    assert len(requested) == 2
    assert "/v1/256x/DEMO_001." in requested[0]
    assert "/v1/tiles/DEMO_001." in requested[1]
    assert art.path.is_file() and tile.path.is_file()
    assert art.locale is None
    assert tile.locale is None
    assert art.is_placeholder is False
    assert tile.is_placeholder is False
    assert art.path.read_bytes() == _jpeg_bytes()
    assert tile.path.read_bytes() == _png_bytes()


def test_cached_download_is_reused_by_same_and_new_resolver(tmp_path, monkeypatch):
    requested = []

    def fake_urlopen(request, timeout=None):
        url = _url_of(request)
        requested.append(url)
        return _image_response(url)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    cache_dir = tmp_path / "shared-cache"

    first_resolver = AssetResolver(cache_dir=cache_dir)
    first = first_resolver.resolve("DEMO_001", kind="art")
    reused = first_resolver.resolve("DEMO_001", kind="art")
    second_resolver_result = AssetResolver(cache_dir=cache_dir).resolve(
        "DEMO_001", kind="art"
    )

    assert len(requested) == 1
    assert reused.path == first.path
    assert second_resolver_result.path == first.path
    assert first.path.read_bytes() == _jpeg_bytes()


def test_404_uses_placeholder_and_is_negative_cached_for_art(tmp_path, monkeypatch):
    requested = []

    def fake_urlopen(request, timeout=None):
        url = _url_of(request)
        requested.append(url)
        raise _not_found(url)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    resolver = AssetResolver(cache_dir=tmp_path / "cache")

    first = resolver.resolve("DEMO_001", kind="art")
    again = resolver.resolve("DEMO_001", kind="art")

    assert first.is_placeholder is True
    assert again.path == first.path
    assert first.locale is None
    assert len(requested) == 1


def test_timeout_is_transient_and_a_later_retry_can_succeed(tmp_path, monkeypatch):
    requested = []

    def fake_urlopen(request, timeout=None):
        url = _url_of(request)
        requested.append(url)
        if len(requested) == 1:
            raise socket.timeout("simulated timeout")
        return _image_response(url)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    resolver = AssetResolver(cache_dir=tmp_path / "cache")

    timed_out = resolver.resolve("DEMO_001", kind="art")
    retried = resolver.resolve("DEMO_001", kind="art")

    assert timed_out.is_placeholder is True
    assert retried.is_placeholder is False
    assert retried.path.read_bytes() == _jpeg_bytes()
    assert len(requested) == 2
    assert requested[0] == requested[1]


def test_incomplete_http_body_uses_placeholder(tmp_path, monkeypatch):
    class IncompleteResponse(_Response):
        def read(self, *_args):
            raise http.client.IncompleteRead(b"partial", 10)

    monkeypatch.setattr(
        "urllib.request.urlopen", lambda request, timeout=None: IncompleteResponse(b"")
    )
    result = AssetResolver(cache_dir=tmp_path / "cache").resolve("DEMO_001", "art")
    assert result.is_placeholder is True
    assert result.path.is_file()
    assert result.media_type == "image/png"


def test_art_rejects_empty_jpeg_tables(tmp_path, monkeypatch):
    malformed = (
        b"\xff\xd8"
        + b"\xff\xdb\x00\x02"
        + b"\xff\xc4\x00\x02"
        + b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
        + b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00"
        + b"\x00\xff\xd9"
    )
    monkeypatch.setattr(
        "urllib.request.urlopen", lambda request, timeout=None: _Response(malformed)
    )
    result = AssetResolver(cache_dir=tmp_path / "cache").resolve("DEMO_001", "art")
    assert result.is_placeholder is True
    assert result.path.is_file()


@pytest.mark.parametrize("card_id", ["../DEMO_001", "DEMO/001", "", 123, None])
def test_invalid_card_ids_are_rejected(card_id, tmp_path):
    resolver = AssetResolver(cache_dir=tmp_path / "cache")
    with pytest.raises(ValueError):
        resolver.describe(card_id)
    with pytest.raises(ValueError):
        resolver.resolve(card_id)


def test_invalid_asset_kind_is_rejected(tmp_path):
    resolver = AssetResolver(cache_dir=tmp_path / "cache")
    with pytest.raises(ValueError):
        resolver.resolve("DEMO_001", kind="thumbnail")
