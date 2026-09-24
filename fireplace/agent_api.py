"""Small, engine-independent API for player decisions.

The classes in this module deliberately contain entity ids and scalar values
only.  A controller is responsible for resolving those ids to Fireplace
objects and for checking that an action is legal in the current game state.
"""

from dataclasses import dataclass, field
from typing import Any, ClassVar, Mapping, Protocol, Sequence, runtime_checkable


PLAY_CARD = "PLAY_CARD"
ATTACK = "ATTACK"
USE_HERO_POWER = "USE_HERO_POWER"
END_TURN = "END_TURN"
CHOOSE = "CHOOSE"
MULLIGAN = "MULLIGAN"

ACTION_TYPES = frozenset(
    {
        PLAY_CARD,
        ATTACK,
        USE_HERO_POWER,
        END_TURN,
        CHOOSE,
        MULLIGAN,
    }
)


_ACTION_KEYS = {
    PLAY_CARD: frozenset(
        {
            "schema_version",
            "type",
            "source_entity_id",
            "target_entity_id",
            "choose_option_entity_id",
            "position",
        }
    ),
    ATTACK: frozenset({"schema_version", "type", "source_entity_id", "target_entity_id"}),
    USE_HERO_POWER: frozenset(
        {
            "schema_version",
            "type",
            "source_entity_id",
            "target_entity_id",
            "choose_option_entity_id",
        }
    ),
    END_TURN: frozenset({"schema_version", "type"}),
    CHOOSE: frozenset({"schema_version", "type", "choice_entity_id"}),
    MULLIGAN: frozenset({"schema_version", "type", "mulligan_entity_ids"}),
}

_REQUIRED_ACTION_KEYS = {
    PLAY_CARD: frozenset({"schema_version", "type", "source_entity_id"}),
    ATTACK: frozenset({"schema_version", "type", "source_entity_id", "target_entity_id"}),
    USE_HERO_POWER: frozenset({"schema_version", "type", "source_entity_id"}),
    END_TURN: frozenset({"schema_version", "type"}),
    CHOOSE: frozenset({"schema_version", "type", "choice_entity_id"}),
    MULLIGAN: frozenset({"schema_version", "type", "mulligan_entity_ids"}),
}


def _validate_id(value: object, field_name: str) -> None:
    """Validate a positive entity id without accepting ``bool`` as an integer."""

    if type(value) is not int:
        raise ValueError(f"{field_name} must be an integer")
    if value <= 0:
        raise ValueError(f"{field_name} must be positive")


def _validate_optional_id(value: object, field_name: str) -> None:
    if value is not None:
        _validate_id(value, field_name)


def _forbid(value: object, field_name: str) -> None:
    if value is not None and value != ():
        raise ValueError(f"{field_name} is not valid for this action type")


@dataclass(frozen=True)
class Action:
    """A single player decision represented by JSON-safe values.

    ``entity_id`` values are valid only for the current game.  They are kept
    as integers here so that the action boundary does not expose Fireplace
    entity objects to an Agent.

    Optional values are omitted by :meth:`to_dict` when they are not used by
    the action type.  ``mulligan_entity_ids`` is normalized to a tuple to keep
    instances immutable, and is emitted as a list because JSON has arrays.
    """

    type: str
    source_entity_id: int | None = None
    target_entity_id: int | None = None
    choose_option_entity_id: int | None = None
    position: int | None = None
    choice_entity_id: int | None = None
    mulligan_entity_ids: tuple[int, ...] = field(default=())

    schema_version: ClassVar[int] = 1

    def __post_init__(self) -> None:
        if type(self.type) is not str:
            raise ValueError("type must be a string")
        if self.type not in ACTION_TYPES:
            raise ValueError(f"unknown action type: {self.type!r}")

        _validate_optional_id(self.source_entity_id, "source_entity_id")
        _validate_optional_id(self.target_entity_id, "target_entity_id")
        _validate_optional_id(self.choose_option_entity_id, "choose_option_entity_id")
        _validate_optional_id(self.choice_entity_id, "choice_entity_id")

        if self.position is not None:
            if type(self.position) is not int:
                raise ValueError("position must be an integer")
            if self.position < 0:
                raise ValueError("position must be nonnegative")

        if isinstance(self.mulligan_entity_ids, tuple):
            mulligan_ids = self.mulligan_entity_ids
        elif isinstance(self.mulligan_entity_ids, list):
            mulligan_ids = tuple(self.mulligan_entity_ids)
            object.__setattr__(self, "mulligan_entity_ids", mulligan_ids)
        else:
            raise ValueError("mulligan_entity_ids must be a tuple or list of integers")

        for entity_id in mulligan_ids:
            _validate_id(entity_id, "mulligan_entity_ids")
        if len(set(mulligan_ids)) != len(mulligan_ids):
            raise ValueError("mulligan_entity_ids must contain unique ids")

        if self.type == PLAY_CARD:
            if self.source_entity_id is None:
                raise ValueError("PLAY_CARD requires source_entity_id")
            _forbid(self.choice_entity_id, "choice_entity_id")
            _forbid(mulligan_ids, "mulligan_entity_ids")
        elif self.type == ATTACK:
            if self.source_entity_id is None:
                raise ValueError("ATTACK requires source_entity_id")
            if self.target_entity_id is None:
                raise ValueError("ATTACK requires target_entity_id")
            _forbid(self.choose_option_entity_id, "choose_option_entity_id")
            _forbid(self.position, "position")
            _forbid(self.choice_entity_id, "choice_entity_id")
            _forbid(mulligan_ids, "mulligan_entity_ids")
        elif self.type == USE_HERO_POWER:
            if self.source_entity_id is None:
                raise ValueError("USE_HERO_POWER requires source_entity_id")
            _forbid(self.position, "position")
            _forbid(self.choice_entity_id, "choice_entity_id")
            _forbid(mulligan_ids, "mulligan_entity_ids")
        elif self.type == END_TURN:
            _forbid(self.source_entity_id, "source_entity_id")
            _forbid(self.target_entity_id, "target_entity_id")
            _forbid(self.choose_option_entity_id, "choose_option_entity_id")
            _forbid(self.position, "position")
            _forbid(self.choice_entity_id, "choice_entity_id")
            _forbid(mulligan_ids, "mulligan_entity_ids")
        elif self.type == CHOOSE:
            if self.choice_entity_id is None:
                raise ValueError("CHOOSE requires choice_entity_id")
            _forbid(self.source_entity_id, "source_entity_id")
            _forbid(self.target_entity_id, "target_entity_id")
            _forbid(self.choose_option_entity_id, "choose_option_entity_id")
            _forbid(self.position, "position")
            _forbid(mulligan_ids, "mulligan_entity_ids")
        elif self.type == MULLIGAN:
            _forbid(self.source_entity_id, "source_entity_id")
            _forbid(self.target_entity_id, "target_entity_id")
            _forbid(self.choose_option_entity_id, "choose_option_entity_id")
            _forbid(self.position, "position")
            _forbid(self.choice_entity_id, "choice_entity_id")

    def to_dict(self) -> dict[str, Any]:
        """Return the canonical JSON-compatible representation."""

        result: dict[str, Any] = {
            "schema_version": self.schema_version,
            "type": self.type,
        }

        if self.type in (PLAY_CARD, ATTACK, USE_HERO_POWER):
            result["source_entity_id"] = self.source_entity_id
        if self.type in (PLAY_CARD, ATTACK, USE_HERO_POWER) and self.target_entity_id is not None:
            result["target_entity_id"] = self.target_entity_id
        if self.type in (PLAY_CARD, USE_HERO_POWER) and self.choose_option_entity_id is not None:
            result["choose_option_entity_id"] = self.choose_option_entity_id
        if self.type == PLAY_CARD and self.position is not None:
            result["position"] = self.position
        if self.type == CHOOSE:
            result["choice_entity_id"] = self.choice_entity_id
        if self.type == MULLIGAN:
            result["mulligan_entity_ids"] = list(self.mulligan_entity_ids)

        return result

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Action":
        """Build an Action from its canonical JSON object.

        The input must contain exactly the keys used by its action type.  This
        catches stale or misspelled fields instead of silently discarding them.
        """

        if not isinstance(data, dict):
            raise ValueError("action payload must be a JSON object")

        if not {"schema_version", "type"} <= set(data):
            raise ValueError("action payload requires schema_version and type")
        if type(data["schema_version"]) is not int or data["schema_version"] != cls.schema_version:
            raise ValueError(f"schema_version must be {cls.schema_version}")
        action_type = data["type"]
        if type(action_type) is not str or action_type not in ACTION_TYPES:
            raise ValueError(f"unknown action type: {action_type!r}")

        allowed_keys = _ACTION_KEYS[action_type]
        required_keys = _REQUIRED_ACTION_KEYS[action_type]
        if not required_keys <= set(data) or not set(data) <= allowed_keys:
            missing = sorted(required_keys - set(data))
            extra = sorted(set(data) - allowed_keys)
            details = []
            if missing:
                details.append(f"missing keys: {', '.join(missing)}")
            if extra:
                details.append(f"unknown keys: {', '.join(extra)}")
            raise ValueError("invalid action shape" + (f" ({'; '.join(details)})" if details else ""))

        kwargs: dict[str, Any] = {"type": action_type}
        for field_name in set(data) - {"schema_version", "type", "mulligan_entity_ids"}:
            value = data[field_name]
            if value is None:
                raise ValueError(f"{field_name} cannot be null")
            kwargs[field_name] = value

        if "mulligan_entity_ids" in data:
            value = data["mulligan_entity_ids"]
            if not isinstance(value, list):
                raise ValueError("mulligan_entity_ids must be a JSON array")
            kwargs["mulligan_entity_ids"] = tuple(value)

        return cls(**kwargs)


@runtime_checkable
class Agent(Protocol):
    """Decision interface independent of Fireplace's engine objects."""

    def choose_action(
        self,
        observation: Mapping[str, Any],
        legal_actions: Sequence[Action],
    ) -> Action:
        """Choose one action from the supplied legal action values."""


__all__ = [
    "Action",
    "Agent",
    "ACTION_TYPES",
    "PLAY_CARD",
    "ATTACK",
    "USE_HERO_POWER",
    "END_TURN",
    "CHOOSE",
    "MULLIGAN",
]
