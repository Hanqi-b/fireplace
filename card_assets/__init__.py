"""Small, dependency-free access to Fireplace card text and card artwork.

The game engine has a deliberately eager card database.  This module is kept
independent from that database so callers that only need a label or an image
can use it without importing the engine or downloading a complete card set.
XML parsing and network access are both lazy: constructing :class:`AssetResolver`
does not read the card definitions or touch the network.
"""

from __future__ import annotations

import os
import re
import struct
import tempfile
import time
import http.client
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator


# These module constants are intentionally public.  Tests and offline callers
# can replace them without having to monkeypatch the resolver implementation.
PACKAGE_DIR = Path(__file__).resolve().parent
REPOSITORY_DIR = PACKAGE_DIR.parent
CARD_DEFS_PATH = REPOSITORY_DIR / "fireplace" / "cards" / "CardDefs.xml"
PLACEHOLDER_PATH = PACKAGE_DIR / "placeholder.png"

IMAGE_BASE_URL = "https://art.hearthstonejson.com"
RENDER_URL_TEMPLATE = IMAGE_BASE_URL + "/v1/render/latest/{locale}/256x/{card_id}.png"
ART_URL_TEMPLATE = IMAGE_BASE_URL + "/v1/256x/{card_id}.jpg"
TILE_URL_TEMPLATE = IMAGE_BASE_URL + "/v1/tiles/{card_id}.png"

HTTP_TIMEOUT = 8.0
NEGATIVE_CACHE_TTL = 24 * 60 * 60
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_IMAGE_SIDE = 4096
MAX_IMAGE_PIXELS = 16 * 1024 * 1024
CACHE_DIR_NAME = "card_assets"
USER_AGENT = "fireplace-card-assets/1"


def _default_url_opener(url: str, *, timeout: float):
    """Open an image URL through urllib.

    Keeping this as a small indirection makes both the standard-library opener
    and the timeout easy to replace in offline tests.
    """

    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": USER_AGENT}),
        timeout=timeout,
    )


URL_OPENER: Callable[..., object] = _default_url_opener


_CARD_ID_RE = re.compile(r"^[A-Za-z0-9_]+$")
_KINDS = frozenset(("render", "art", "tile"))
_LOCALES = ("zhCN", "enUS")


@dataclass(frozen=True)
class CardText:
    """Localized card name and rules text.

    ``locale`` is the common locale used by both fields when they share one.
    It is ``"und"`` (undetermined) when a field had to fall back to the card
    ID or when the two fields came from different locales.
    """

    name: str
    text: str
    locale: str | None


@dataclass(frozen=True)
class ResolvedAsset:
    """A local image path suitable for passing to a UI or another consumer."""

    path: Path
    media_type: str
    locale: str | None
    is_placeholder: bool


@dataclass(frozen=True)
class _LocalizedField:
    value: str
    locale: str | None


@dataclass(frozen=True)
class _CardRecord:
    name: dict[str, str]
    text: dict[str, str]


class _CardCatalog:
    """Lazy, independent reader for the local CardDefs.xml file."""

    def __init__(self, path: Path):
        self.path = path
        self._loaded = False
        self._cards: dict[str, _CardRecord] = {}

    def get(self, card_id: str) -> _CardRecord | None:
        if not self._loaded:
            self._load()
        return self._cards.get(card_id)

    def _load(self) -> None:
        self._loaded = True
        try:
            events: Iterator[tuple[str, ET.Element]] = ET.iterparse(
                self.path, events=("end",)
            )
            for _event, element in events:
                if element.tag != "Entity":
                    continue
                card_id = element.attrib.get("CardID")
                if card_id:
                    fields: dict[str, dict[str, str]] = {
                        "CARDNAME": {},
                        "CARDTEXT": {},
                    }
                    for tag in element.findall("Tag"):
                        field_name = tag.attrib.get("name")
                        if field_name not in fields:
                            continue
                        values = fields[field_name]
                        for child in list(tag):
                            # Preserve intentional line breaks in translated
                            # card text, while treating an empty value as
                            # unavailable for locale fallback.
                            value = child.text or ""
                            if value:
                                values[child.tag] = value
                    self._cards[card_id] = _CardRecord(
                        name=fields["CARDNAME"], text=fields["CARDTEXT"]
                    )
                # ElementTree otherwise keeps every entity in memory.  The
                # package only needs the two localized fields.
                element.clear()
        except (OSError, ET.ParseError):
            # A source checkout may be packaged without the large XML file.
            # Descriptions still have a stable card-ID fallback in that case.
            self._cards.clear()


def _default_cache_dir() -> Path:
    xdg_cache = os.environ.get("XDG_CACHE_HOME")
    if xdg_cache:
        return Path(xdg_cache) / CACHE_DIR_NAME
    return Path.home() / ".cache" / CACHE_DIR_NAME


def _validate_card_id(card_id: str) -> str:
    if not isinstance(card_id, str) or not card_id:
        raise ValueError("card_id must be a non-empty ASCII card ID")
    if len(card_id) > 128 or not _CARD_ID_RE.fullmatch(card_id):
        raise ValueError("card_id contains unsafe characters")
    return card_id


def _validate_kind(kind: str) -> str:
    if not isinstance(kind, str) or kind not in _KINDS:
        raise ValueError("kind must be one of: render, art, tile")
    return kind


def _pick_localized(values: dict[str, str], card_id: str) -> _LocalizedField:
    for locale in _LOCALES:
        value = values.get(locale)
        if value:
            return _LocalizedField(value=value, locale=locale)
    return _LocalizedField(value=card_id, locale=None)


def _png_is_valid(data: bytes) -> bool:
    signature = b"\x89PNG\r\n\x1a\n"
    if len(data) < len(signature) + 12 or not data.startswith(signature):
        return False

    offset = len(signature)
    saw_ihdr = False
    saw_iend = False
    idat = bytearray()
    width = height = row_bytes = 0
    while offset + 12 <= len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        chunk_type = data[offset + 4 : offset + 8]
        chunk_end = offset + 12 + length
        if chunk_end > len(data):
            return False
        chunk_payload = data[offset + 8 : offset + 8 + length]
        expected_crc = struct.unpack_from(">I", data, offset + 8 + length)[0]
        if expected_crc != zlib.crc32(chunk_type + chunk_payload) & 0xFFFFFFFF:
            return False
        if not saw_ihdr:
            if chunk_type != b"IHDR" or length != 13:
                return False
            width, height, depth, color, compression, filtering, interlace = (
                struct.unpack_from(">IIBBBBB", data, offset + 8)
            )
            channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
            valid_depths = {
                0: (1, 2, 4, 8, 16),
                2: (8, 16),
                3: (1, 2, 4, 8),
                4: (8, 16),
                6: (8, 16),
            }
            if (
                not width
                or not height
                or width > MAX_IMAGE_SIDE
                or height > MAX_IMAGE_SIDE
                or width * height > MAX_IMAGE_PIXELS
                or channels is None
                or depth not in valid_depths.get(color, ())
                or compression != 0
                or filtering != 0
                or interlace != 0
            ):
                return False
            row_bytes = (width * channels * depth + 7) // 8
            saw_ihdr = True
        elif chunk_type == b"IHDR":
            return False
        if chunk_type == b"IDAT":
            idat.extend(chunk_payload)
        if chunk_type == b"IEND":
            if length != 0:
                return False
            saw_iend = True
            # A valid PNG has no second image or HTML payload after IEND.
            if chunk_end != len(data):
                return False
            break
        offset = chunk_end
    if not (saw_ihdr and saw_iend and idat):
        return False
    expected_size = height * (row_bytes + 1)
    try:
        decoder = zlib.decompressobj()
        pixels = decoder.decompress(idat, expected_size + 1)
    except zlib.error:
        return False
    if len(pixels) != expected_size or not decoder.eof or decoder.unconsumed_tail:
        return False
    return all(pixels[row * (row_bytes + 1)] <= 4 for row in range(height))


_JPEG_SOF_MARKERS = frozenset(
    (
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    )
)


def _jpeg_dqt_is_valid(payload: bytes) -> bool:
    offset = 0
    while offset < len(payload):
        info = payload[offset]
        precision, table_id = info >> 4, info & 0x0F
        if precision not in (0, 1) or table_id > 3:
            return False
        offset += 1 + 64 * (precision + 1)
    return bool(payload) and offset == len(payload)


def _jpeg_dht_is_valid(payload: bytes) -> bool:
    offset = 0
    while offset < len(payload):
        if offset + 17 > len(payload):
            return False
        info = payload[offset]
        if info >> 4 not in (0, 1) or info & 0x0F > 3:
            return False
        symbols = sum(payload[offset + 1 : offset + 17])
        if symbols == 0:
            return False
        offset += 17 + symbols
    return bool(payload) and offset == len(payload)


def _jpeg_is_valid(data: bytes) -> bool:
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return False
    offset = 2
    saw_sof = False
    saw_dqt = False
    saw_dht = False
    saw_sos = False
    saw_eoi = False
    while offset < len(data):
        if data[offset] != 0xFF:
            # Entropy-coded bytes are only valid after SOS.  We do not need to
            # inspect them in detail, but a marker parser must reach SOS first.
            return False
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            return False
        marker = data[offset]
        offset += 1
        if marker == 0xD9:
            saw_eoi = True
            break
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        if offset + 2 > len(data):
            return False
        segment_length = struct.unpack_from(">H", data, offset)[0]
        if segment_length < 2 or offset + segment_length > len(data):
            return False
        if marker in _JPEG_SOF_MARKERS:
            if segment_length < 7:
                return False
            height, width = struct.unpack_from(">HH", data, offset + 3)
            if (
                width == 0
                or height == 0
                or width > MAX_IMAGE_SIDE
                or height > MAX_IMAGE_SIDE
                or width * height > MAX_IMAGE_PIXELS
            ):
                return False
            saw_sof = True
        payload = data[offset + 2 : offset + segment_length]
        if marker == 0xDB:
            if not _jpeg_dqt_is_valid(payload):
                return False
            saw_dqt = True
        if marker == 0xC4:
            if not _jpeg_dht_is_valid(payload):
                return False
            saw_dht = True
        offset += segment_length
        if marker == 0xDA:  # SOS: scan entropy bytes until the next marker.
            saw_sos = True
            while offset < len(data):
                if data[offset] != 0xFF:
                    offset += 1
                    continue
                marker_start = offset
                while offset < len(data) and data[offset] == 0xFF:
                    offset += 1
                if offset >= len(data):
                    return False
                next_marker = data[offset]
                if next_marker == 0x00:
                    offset += 1
                    continue
                # Resume the outer loop at the marker prefix.  The outer loop
                # consumes the prefix and marker code together.
                offset = marker_start
                break
    return (
        saw_sof and saw_dqt and saw_dht and saw_sos and saw_eoi and offset == len(data)
    )


def _image_is_valid(data: bytes, media_type: str) -> bool:
    if not data or len(data) > MAX_IMAGE_BYTES:
        return False
    if media_type == "image/png":
        return _png_is_valid(data)
    if media_type == "image/jpeg":
        return _jpeg_is_valid(data)
    return False


def _read_response(response: object) -> bytes:
    reader = getattr(response, "read", None)
    if not callable(reader):
        raise OSError("image response has no read method")
    try:
        data = reader(MAX_IMAGE_BYTES + 1)
    except TypeError:
        # Small fake response objects often only implement read().
        data = reader()
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise OSError("image response did not return bytes")
    return bytes(data)


def _close_response(response: object) -> None:
    close = getattr(response, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


class AssetResolver:
    """Resolve localized card text and on-demand local card image assets."""

    def __init__(self, cache_dir: str | os.PathLike[str] | None = None):
        self.cache_dir = (
            Path(cache_dir) if cache_dir is not None else _default_cache_dir()
        )
        # Read the module-level path when the resolver is constructed so tests
        # can point it to a tiny XML fixture before creating a resolver.
        self.xml_path = Path(CARD_DEFS_PATH)
        self._catalog: _CardCatalog | None = None

    def _get_catalog(self) -> _CardCatalog:
        if self._catalog is None:
            self._catalog = _CardCatalog(self.xml_path)
        return self._catalog

    def describe(self, card_id: str) -> CardText:
        card_id = _validate_card_id(card_id)
        record = self._get_catalog().get(card_id)
        if record is None:
            return CardText(name=card_id, text=card_id, locale="und")
        name = _pick_localized(record.name, card_id)
        text = _pick_localized(record.text, card_id)
        locale = (
            name.locale
            if name.locale is not None and name.locale == text.locale
            else "und"
        )
        return CardText(name=name.value, text=text.value, locale=locale)

    def resolve(self, card_id: str, kind: str = "render") -> ResolvedAsset:
        card_id = _validate_card_id(card_id)
        kind = _validate_kind(kind)
        media_type = "image/jpeg" if kind == "art" else "image/png"

        # A cache directory that cannot be created or accessed must not make a
        # UI fail to render a card.  The packaged placeholder is always local.
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            return self._placeholder(media_type)

        locales: tuple[str | None, ...]
        if kind == "render":
            locales = _LOCALES
        else:
            locales = (None,)

        # Check every existing locale before attempting a download.  A cached
        # English fallback should still work instantly when Chinese requests
        # start timing out after it was cached.
        for locale in locales:
            cache_path = self._cache_path(card_id, kind, locale)
            try:
                if cache_path.is_file() and self._valid_cached_file(
                    cache_path, media_type
                ):
                    return ResolvedAsset(
                        path=cache_path,
                        media_type=media_type,
                        locale=locale,
                        is_placeholder=False,
                    )
            except OSError:
                return self._placeholder(media_type)

        for locale in locales:
            cache_path = self._cache_path(card_id, kind, locale)
            marker_path = self._missing_path(cache_path)
            if self._missing_marker_is_fresh(marker_path):
                continue

            url = self._url(card_id, kind, locale)
            result = self._download(url, media_type)
            if result is None:
                continue
            if result is _NOT_FOUND:
                try:
                    self._write_missing_marker(marker_path)
                except OSError:
                    # Negative caching is an optimization.  A read-only cache
                    # must still return a placeholder rather than an exception.
                    pass
                continue
            data = result
            try:
                self._atomic_write(cache_path, data)
            except OSError:
                return self._placeholder(media_type)
            return ResolvedAsset(
                path=cache_path,
                media_type=media_type,
                locale=locale,
                is_placeholder=False,
            )

        return self._placeholder(media_type)

    def _placeholder(self, media_type: str) -> ResolvedAsset:
        # The bundled fallback is always a PNG, including when the requested
        # remote art endpoint normally serves JPEG bytes.
        return ResolvedAsset(
            path=PLACEHOLDER_PATH,
            media_type="image/png",
            locale=None,
            is_placeholder=True,
        )

    def _cache_path(self, card_id: str, kind: str, locale: str | None) -> Path:
        locale_part = locale or "default"
        extension = "jpg" if kind == "art" else "png"
        return self.cache_dir / f"{card_id}.{kind}.{locale_part}.{extension}"

    @staticmethod
    def _missing_path(cache_path: Path) -> Path:
        return cache_path.with_name(cache_path.name + ".missing")

    @staticmethod
    def _missing_marker_is_fresh(marker_path: Path) -> bool:
        if NEGATIVE_CACHE_TTL <= 0:
            return False
        try:
            timestamp = float(marker_path.read_text(encoding="ascii"))
        except (OSError, ValueError, UnicodeError):
            return False
        return time.time() - timestamp < NEGATIVE_CACHE_TTL

    @staticmethod
    def _write_missing_marker(marker_path: Path) -> None:
        AssetResolver._atomic_write(marker_path, f"{time.time():.6f}\n".encode("ascii"))

    @staticmethod
    def _valid_cached_file(path: Path, media_type: str) -> bool:
        try:
            with path.open("rb") as cached:
                data = cached.read(MAX_IMAGE_BYTES + 1)
        except OSError:
            return False
        return _image_is_valid(data, media_type)

    def _url(self, card_id: str, kind: str, locale: str | None) -> str:
        if kind == "render":
            assert locale is not None
            return RENDER_URL_TEMPLATE.format(locale=locale, card_id=card_id)
        if kind == "art":
            return ART_URL_TEMPLATE.format(card_id=card_id)
        return TILE_URL_TEMPLATE.format(card_id=card_id)

    @staticmethod
    def _download(url: str, media_type: str) -> bytes | object | None:
        try:
            response = URL_OPENER(url, timeout=HTTP_TIMEOUT)
        except urllib.error.HTTPError as exc:
            try:
                return _NOT_FOUND if getattr(exc, "code", None) == 404 else None
            finally:
                exc.close()
        except (
            OSError,
            TimeoutError,
            urllib.error.URLError,
            http.client.HTTPException,
        ):
            return None

        status = getattr(response, "status", None)
        if status is None:
            getcode = getattr(response, "getcode", None)
            if callable(getcode):
                try:
                    status = getcode()
                except Exception:
                    status = None
        try:
            status = int(status) if status is not None else None
        except (TypeError, ValueError):
            status = None
        if status is not None and status >= 400:
            _close_response(response)
            return _NOT_FOUND if status == 404 else None

        try:
            data = _read_response(response)
        except (OSError, ValueError, TypeError, http.client.HTTPException):
            return None
        finally:
            _close_response(response)
        if not _image_is_valid(data, media_type):
            return None
        return data

    @staticmethod
    def _atomic_write(path: Path, data: bytes) -> None:
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=path.parent, prefix=f".{path.name}.", delete=False
            ) as temporary:
                temporary_name = temporary.name
                temporary.write(data)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_name, path)
            temporary_name = None
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass


class _NotFound:
    pass


_NOT_FOUND = _NotFound()


__all__ = [
    "AssetResolver",
    "CardText",
    "ResolvedAsset",
    "CARD_DEFS_PATH",
    "PLACEHOLDER_PATH",
    "IMAGE_BASE_URL",
    "RENDER_URL_TEMPLATE",
    "ART_URL_TEMPLATE",
    "TILE_URL_TEMPLATE",
    "HTTP_TIMEOUT",
    "NEGATIVE_CACHE_TTL",
    "URL_OPENER",
]
