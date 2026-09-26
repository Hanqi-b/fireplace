"""Asynchronous, browser-safe access to optional card assets.

The game request path must never wait for card artwork or for the first parse
of ``CardDefs.xml``.  :class:`AssetService` therefore keeps only small
in-memory coordination state and performs all resolver calls and file reads in
a private executor.  It deliberately exposes bytes and immutable scalar
metadata rather than the resolver's path object or any Fireplace object.

The service is optional.  Passing ``resolver=None`` disables the asset
package, in which case descriptions remain empty and asset futures resolve to
``None``.  Omitting ``resolver`` lazily constructs the installed
``card_assets.AssetResolver`` with its external default cache directory.
"""

from __future__ import annotations

import concurrent.futures
import mimetypes
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from concurrent.futures import Future
from typing import Any, Callable


_DEFAULT_RESOLVER = object()
_VALID_KINDS = frozenset(("render", "art", "tile"))
_VALID_LOCALES = frozenset(("zhCN", "enUS"))
_CARD_ID_RE = re.compile(r"^[A-Za-z0-9_]{1,128}$")
_DESCRIPTION_RETRY_SECONDS = 1.0
_ASSET_CACHE_LIMIT = 64

@dataclass(frozen=True, slots=True)
class AssetDescription:
    """Localized text safe to include in a browser observation."""

    name: str
    text: str
    locale: str | None


@dataclass(frozen=True, slots=True)
class AssetPayload:
    """Immutable bytes and metadata returned by :meth:`request_asset`."""

    data: bytes
    media_type: str
    locale: str | None
    is_placeholder: bool


def _field(value: object, name: str, default: Any = None) -> Any:
    """Read a scalar value from either a resolver object or mapping."""

    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _card_id(value: object) -> str | None:
    if not isinstance(value, str) or not _CARD_ID_RE.fullmatch(value):
        return None
    return value


def _kind(value: object) -> str | None:
    if not isinstance(value, str) or value not in _VALID_KINDS:
        return None
    return value


def _validate_locale(value: object) -> str:
    if not isinstance(value, str) or value not in _VALID_LOCALES:
        raise ValueError("locale must be one of: zhCN, enUS")
    return value


def _asset_key(card_id: str, kind: str, locale: str) -> tuple[str, str, str | None]:
    # Art and tile endpoints are language-neutral.  Sharing their cache entry
    # avoids retaining duplicate payloads when the user changes UI language.
    return (card_id, kind, locale if kind == "render" else None)


def _default_resolver_factory() -> object | None:
    """Import the optional package only inside a worker thread."""

    try:
        from card_assets import AssetResolver
    except Exception:
        return None
    try:
        # ``None`` is intentional: card_assets chooses ~/.cache or XDG cache,
        # which keeps downloaded files outside this repository.
        return AssetResolver(cache_dir=None)
    except Exception:
        return None


class AssetService:
    """Schedule optional card text and images without blocking game requests.

    ``describe_visible`` returns only descriptions already available in the
    service cache.  It submits a worker for each missing safe card id and is
    therefore suitable for use while constructing every HTTP snapshot.  The
    next snapshot can use the newly cached values.

    ``request_asset`` returns a :class:`~concurrent.futures.Future`
    immediately.  Render requests for the same ``(card_id, kind, locale)``
    share the active future; art and tile requests share one language-neutral
    key.  Completed real images are kept in a small bounded memory cache so a
    browser retry after a pending response can receive bytes at once.  The
    resolver's external disk cache remains the persistent store.
    """

    def __init__(
        self,
        resolver: object = _DEFAULT_RESOLVER,
        *,
        max_workers: int = 4,
        resolver_factory: Callable[[], object | None] | None = None,
    ) -> None:
        if type(max_workers) is not int or max_workers <= 0:
            raise ValueError("max_workers must be a positive integer")

        self._lock = threading.RLock()
        self._resolver_init_lock = threading.Lock()
        # AssetResolver's lazy XML catalog is not itself synchronized.  Keep
        # its description calls serialized without holding the service lock;
        # asset resolution remains independent and can proceed concurrently.
        self._resolver_describe_lock = threading.Lock()
        self._resolver_factory = (
            resolver_factory
            if resolver_factory is not None
            else _default_resolver_factory
        )
        self._resolver_ready = resolver is not _DEFAULT_RESOLVER
        self._resolver = None if resolver is _DEFAULT_RESOLVER else resolver
        self._descriptions: dict[tuple[str, str], AssetDescription] = {}
        self._description_inflight: dict[
            tuple[str, str], Future[AssetDescription | None]
        ] = {}
        # ``None`` means permanently disabled (an explicitly absent resolver);
        # a monotonic deadline lets a transient catalog failure be retried.
        self._description_failed: dict[tuple[str, str], float | None] = {}
        self._asset_inflight: dict[
            tuple[str, str, str | None], Future[AssetPayload | None]
        ] = {}
        self._asset_cache: OrderedDict[
            tuple[str, str, str | None], AssetPayload
        ] = OrderedDict()
        self._closed = False
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="fireplace-web-assets",
        )

    def __enter__(self) -> "AssetService":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()

    def close(self, *, wait: bool = True) -> None:
        """Stop workers; repeated calls are harmless."""

        with self._lock:
            if self._closed:
                return
            self._closed = True
            executor = self._executor
        # Do not hold the service lock while waiting for worker completion.
        # A finished worker invokes a short callback that takes this lock.
        executor.shutdown(wait=wait, cancel_futures=True)

    def describe_visible(
        self, card_ids: Iterable[object], locale: str = "zhCN"
    ) -> dict[str, AssetDescription]:
        """Return cached descriptions and schedule safe cache misses.

        Invalid ids are ignored.  Resolver absence is recorded as disabled,
        while a transient resolver error gets a short retry deadline.  This
        prevents a failed card from creating a worker on every HTTP poll
        without making a temporary asset outage permanent.
        """

        locale = _validate_locale(locale)
        if isinstance(card_ids, str):
            card_ids = (card_ids,)
        try:
            ids = tuple(dict.fromkeys(
                card_id for value in card_ids if (card_id := _card_id(value)) is not None
            ))
        except (TypeError, ValueError):
            ids = ()

        with self._lock:
            result = {
                card_id: self._descriptions[(card_id, locale)]
                for card_id in ids
                if (card_id, locale) in self._descriptions
            }
            if self._closed:
                return result

            disabled = self._resolver_ready and self._resolver is None
            now = time.monotonic()
            for card_id in ids:
                key = (card_id, locale)
                if key in self._descriptions or key in self._description_inflight:
                    continue
                if key in self._description_failed:
                    retry_at = self._description_failed[key]
                    if retry_at is None or now < retry_at:
                        continue
                    self._description_failed.pop(key, None)
                if disabled:
                    self._description_failed[key] = None
                    continue
                try:
                    future = self._executor.submit(self._describe_one, card_id, locale)
                except RuntimeError:
                    self._description_failed[key] = None
                    continue
                self._description_inflight[key] = future
                future.add_done_callback(
                    lambda done, key=key: self._finish_description(key, done)
                )
            return result

    def request_asset(
        self,
        card_id: object,
        kind: object = "render",
        locale: str = "zhCN",
    ) -> Future[AssetPayload | None]:
        """Return a nonblocking future for one local asset.

        Invalid values, an explicitly disabled resolver, and resolver errors
        produce a completed future whose result is ``None``.  A real resolver
        may instead return its own offline placeholder, which is converted to
        :class:`AssetPayload`.
        """

        normalized_locale = _validate_locale(locale)
        normalized_card_id = _card_id(card_id)
        normalized_kind = _kind(kind)
        if normalized_card_id is None or normalized_kind is None:
            return self._completed_future(None)

        key = _asset_key(normalized_card_id, normalized_kind, normalized_locale)
        with self._lock:
            if self._closed or (self._resolver_ready and self._resolver is None):
                return self._completed_future(None)
            cached = self._asset_cache.get(key)
            if cached is not None:
                self._asset_cache.move_to_end(key)
                return self._completed_future(cached)
            existing = self._asset_inflight.get(key)
            if existing is not None:
                return existing
            try:
                future = self._executor.submit(
                    self._resolve_one,
                    normalized_card_id,
                    normalized_kind,
                    normalized_locale,
                )
            except RuntimeError:
                return self._completed_future(None)
            self._asset_inflight[key] = future
            future.add_done_callback(
                lambda done, key=key: self._finish_asset(key, done)
            )
            return future

    def _get_resolver(self) -> object | None:
        if self._resolver_ready:
            return self._resolver
        with self._resolver_init_lock:
            if self._resolver_ready:
                return self._resolver
            try:
                resolver = self._resolver_factory()
            except Exception:
                resolver = None
            self._resolver = resolver
            self._resolver_ready = True
            return resolver

    def _describe_one(self, card_id: str, locale: str) -> AssetDescription | None:
        resolver = self._get_resolver()
        if resolver is None:
            return None
        try:
            # The lock protects AssetResolver's lazy catalog initialization;
            # it is deliberately not the service lock and is never held by
            # snapshot construction or by an asset request.
            with self._resolver_describe_lock:
                try:
                    description = resolver.describe(  # type: ignore[attr-defined]
                        card_id, locale=locale
                    )
                except TypeError:
                    # Keep old resolver doubles and older installations
                    # working for the default Chinese mode.  An old resolver
                    # cannot safely promise English text, so do not retry it
                    # for enUS and accidentally expose Chinese content.
                    if locale != "zhCN":
                        return None
                    description = resolver.describe(card_id)  # type: ignore[attr-defined]
        except Exception:
            return None
        return self._coerce_description(card_id, description, locale)

    @staticmethod
    def _coerce_description(
        card_id: str, value: object, requested_locale: str
    ) -> AssetDescription | None:
        name = _field(value, "name")
        text = _field(value, "text")
        locale = _field(value, "locale")
        if name is None or text is None:
            return None
        if not isinstance(name, str):
            name = str(name)
        if not isinstance(text, str):
            text = str(text)
        if locale is not None and not isinstance(locale, str):
            locale = str(locale)
        # A resolver that ignores the locale argument must not turn an
        # English request into a Chinese card.  ``und`` is allowed because it
        # represents an ID fallback, not a hidden translation.
        if requested_locale == "enUS" and locale == "zhCN":
            return None
        return AssetDescription(name=name or card_id, text=text or card_id, locale=locale)

    def _finish_description(
        self,
        key: tuple[str, str],
        future: Future[AssetDescription | None],
    ) -> None:
        try:
            value = future.result()
        except Exception:
            value = None
        with self._lock:
            current = self._description_inflight.get(key)
            if current is not future:
                return
            self._description_inflight.pop(key, None)
            if value is None:
                self._description_failed[key] = (
                    time.monotonic() + _DESCRIPTION_RETRY_SECONDS
                )
            else:
                self._descriptions[key] = value

    def _resolve_one(
        self, card_id: str, kind: str, requested_locale: str
    ) -> AssetPayload | None:
        resolver = self._get_resolver()
        if resolver is None:
            return None
        try:
            try:
                resolved = resolver.resolve(  # type: ignore[attr-defined]
                    card_id, kind=kind, locale=requested_locale
                )
            except TypeError:
                # art/tile are language-neutral, so an older resolver remains
                # usable for those kinds.  Render assets only fall back to the
                # old signature for the default Chinese mode.
                if kind == "render" and requested_locale != "zhCN":
                    return None
                resolved = resolver.resolve(card_id, kind=kind)  # type: ignore[attr-defined]
        except Exception:
            return None
        path_value = _field(resolved, "path")
        if not path_value:
            return None
        try:
            path = Path(path_value).expanduser().resolve()
            data = path.read_bytes()
        except (OSError, RuntimeError, TypeError, ValueError):
            return None
        media_type = _field(resolved, "media_type")
        if not isinstance(media_type, str) or not media_type:
            media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        locale = _field(resolved, "locale")
        if locale is not None and not isinstance(locale, str):
            locale = str(locale)
        if (
            kind == "render"
            and requested_locale == "enUS"
            and locale == "zhCN"
        ):
            # A resolver that ignores the locale argument must not leak a
            # Chinese render into an English game.  A placeholder has no
            # locale and remains safe to return.
            return None
        return AssetPayload(
            data=bytes(data),
            media_type=media_type,
            locale=locale,
            is_placeholder=bool(_field(resolved, "is_placeholder", False)),
        )

    def _finish_asset(
        self,
        key: tuple[str, str, str | None],
        future: Future[AssetPayload | None],
    ) -> None:
        try:
            value = future.result()
        except Exception:
            value = None
        with self._lock:
            current = self._asset_inflight.get(key)
            if current is future:
                self._asset_inflight.pop(key, None)
                if value is not None and not value.is_placeholder:
                    self._asset_cache[key] = value
                    self._asset_cache.move_to_end(key)
                    if len(self._asset_cache) > _ASSET_CACHE_LIMIT:
                        self._asset_cache.popitem(last=False)

    @staticmethod
    def _completed_future(value: AssetPayload | None) -> Future[AssetPayload | None]:
        future: Future[AssetPayload | None] = Future()
        future.set_result(value)
        return future


__all__ = ["AssetDescription", "AssetPayload", "AssetService"]
