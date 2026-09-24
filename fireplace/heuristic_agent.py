"""A small deterministic policy built on the public Agent boundary.

``HeuristicAgent`` deliberately sees only the JSON-safe observation and the
already enumerated legal actions.  It does not resolve entity ids, inspect
Fireplace objects, or try to predict card effects.  The policy is intentionally
conservative: visible lethal attacks and favourable trades come first, then
known playable cards and hero powers, with ``END_TURN`` as the fallback when
there is no visible positive action.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .agent_api import (
    ATTACK,
    CHOOSE,
    END_TURN,
    MULLIGAN,
    PLAY_CARD,
    USE_HERO_POWER,
    Action,
)


# A small public-card policy hint for effects that help their target.  This is
# only a target preference; the controller still determines every legal
# target and the engine still resolves the effect.
_HEAL_POWER_AMOUNTS = {
    "HERO_09bp": 2,
    "CS1h_001_H1": 2,
    "CS1h_001_H2": 2,
    "HERO_09bp2": 4,
    "CS1h_001_H1_AT_132": 4,
    "CS1h_001_H2_AT_132": 4,
}
_FRIENDLY_TARGET_CARD_IDS = frozenset(_HEAL_POWER_AMOUNTS) | {
    "CS2_004",  # Power Word: Shield
    "GIL_145",  # Sound the Bells!
}
_OFFENSIVE_TARGET_CARD_IDS = frozenset({
    "CS2_024",  # Frostbolt
    "CS2_029",  # Fireball
})
_LIFE_TAP_CARD_IDS = frozenset({"HERO_07bp", "CS2_056_H1", "CS2_056_H2"})


def _field(value: object, name: str, default: Any = None) -> Any:
    """Read a value from either a JSON mapping or an Action-like value."""

    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _items(value: object) -> tuple[object, ...]:
    if value is None or isinstance(value, (str, bytes, Mapping)):
        return ()
    try:
        return tuple(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return ()


def _integer(value: object, default: int | None = None) -> int | None:
    """Read an integer JSON value without turning text into a number."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    try:
        result = int(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return result


def _entity_id(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value if value > 0 else None
    value = _field(value, "entity_id")
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _action_type(action: object) -> str:
    value = _field(action, "type")
    value = getattr(value, "value", value)
    return str(value).upper() if value is not None else ""


def _find_by_id(values: Sequence[object], entity_id: int | None) -> Mapping[str, Any]:
    if entity_id is None:
        return {}
    for value in values:
        if _entity_id(value) == entity_id:
            return _mapping(value)
    return {}


def _selected_ids(action: object) -> tuple[int, ...]:
    selected = _field(action, "mulligan_entity_ids", ())
    result: list[int] = []
    for value in _items(selected):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            continue
        result.append(value)
    return tuple(result)


def _score_best(
    actions: Sequence[Action],
    score_action,
) -> tuple[Action | None, tuple[int, ...] | None]:
    """Pick the first action with the best score.

    Keeping the first action on a tie makes the policy deterministic while
    preserving the legal-action provider's stable ordering.  No set, hash, or
    random source participates in the decision.
    """

    best_action: Action | None = None
    best_score: tuple[int, ...] | None = None
    for action in actions:
        score = score_action(action)
        if best_score is None or score > best_score:
            best_action = action
            best_score = score
    return best_action, best_score


def _option_score(cost: int, budget: int) -> tuple[int, ...]:
    """Prefer an affordable option that uses the current curve efficiently."""

    if cost <= budget:
        # Among affordable cards, the one closest to the current budget makes
        # the most use of the visible mana.  The final component is only a
        # deterministic numeric tie breaker; list order still wins exact ties.
        return (1, cost, -(budget - cost), -cost)
    # If every option is above budget, keep the least expensive option in mind
    # for a later turn rather than selecting an arbitrarily large card.
    return (0, -cost, -(cost - budget), -cost)


class HeuristicAgent:
    """Choose legal actions with a deterministic, visibility-limited policy."""

    def choose_action(
        self,
        observation: Mapping[str, Any],
        legal_actions: Sequence[Action],
    ) -> Action:
        """Return one of ``legal_actions`` using only value-object fields."""

        actions = tuple(legal_actions)
        if not actions:
            raise ValueError("HeuristicAgent received no legal actions")

        phase = str(_field(observation, "phase", "MAIN")).upper()
        if phase == "MULLIGAN":
            return self._choose_mulligan(observation, actions)
        if phase == "CHOICE":
            return self._choose_choice(observation, actions)
        return self._choose_main(observation, actions)

    def _choose_mulligan(
        self,
        observation: Mapping[str, Any],
        actions: Sequence[Action],
    ) -> Action:
        pending = _mapping(_field(observation, "pending_choice", {}))
        options = _items(_field(pending, "options", ()))
        costs: list[tuple[int, int | None]] = []
        for option in options:
            costs.append((_entity_id(option) or -1, _integer(_field(option, "cost"))))

        def score(action: Action) -> tuple[int, ...]:
            if _action_type(action) != MULLIGAN:
                return (-1, 0, 0, 0)
            selected = _selected_ids(action)
            high_count = 0
            high_cost = 0
            low_count = 0
            unknown_count = 0
            for entity_id in selected:
                cost = None
                for option_id, option_cost in costs:
                    if option_id == entity_id:
                        cost = option_cost
                        break
                if cost is None:
                    unknown_count += 1
                elif cost >= 4:
                    high_count += 1
                    high_cost += cost
                else:
                    low_count += 1
            # First replace as many expensive cards as possible.  The next
            # components retain lower cost cards and unknown options.
            return (high_count, high_cost, -low_count, -unknown_count)

        best, _ = _score_best(actions, score)
        assert best is not None
        return best

    def _choose_choice(
        self,
        observation: Mapping[str, Any],
        actions: Sequence[Action],
    ) -> Action:
        choices = tuple(action for action in actions if _action_type(action) == CHOOSE)
        if not choices:
            return actions[0]

        pending = _mapping(_field(observation, "pending_choice", {}))
        options = _items(_field(pending, "options", ()))
        if not options:
            # There is no public option metadata to score.  This is a stable,
            # conservative fallback and remains a legal value action.
            return choices[0]

        option_data: list[tuple[int, int | None]] = []
        for option in options:
            option_data.append(
                (_entity_id(option) or -1, _integer(_field(option, "cost")))
            )

        # A missing public cost means that scoring would invent card
        # information.  Select the first visible option instead.
        if any(option_id <= 0 or cost is None for option_id, cost in option_data):
            first_id = option_data[0][0]
            for action in choices:
                if _field(action, "choice_entity_id") == first_id:
                    return action
            return choices[0]

        self_view = _mapping(_field(observation, "self", {}))
        budget = _integer(_field(self_view, "mana"))
        if budget is None:
            budget = _integer(_field(self_view, "max_mana"))
        if budget is None:
            first_id = option_data[0][0]
            for action in choices:
                if _field(action, "choice_entity_id") == first_id:
                    return action
            return choices[0]

        def score(action: Action) -> tuple[int, ...]:
            choice_id = _field(action, "choice_entity_id")
            for option_id, cost in option_data:
                if choice_id == option_id:
                    assert cost is not None
                    return _option_score(cost, budget)
            return (-1, -1, -1, -1)

        best, _ = _score_best(choices, score)
        assert best is not None
        return best

    def _choose_main(
        self,
        observation: Mapping[str, Any],
        actions: Sequence[Action],
    ) -> Action:
        self_view = _mapping(_field(observation, "self", {}))
        opponent = _mapping(_field(observation, "opponent", {}))
        context = {
            "hero": _mapping(_field(self_view, "hero", {})),
            "opponent_hero": _mapping(_field(opponent, "hero", {})),
            "board": _items(_field(self_view, "board", ())),
            "opponent_board": _items(_field(opponent, "board", ())),
            "hand": _items(_field(self_view, "hand", ())),
            "hero_power": _mapping(_field(self_view, "hero_power", {})),
            "mana": _integer(_field(self_view, "mana")),
            "deck_count": _integer(_field(self_view, "deck_count")),
        }
        sides_by_source: dict[int, set[str]] = {}
        for action in actions:
            if _action_type(action) != PLAY_CARD:
                continue
            source_id = _entity_id(_field(action, "source_entity_id"))
            target_id = _entity_id(_field(action, "target_entity_id"))
            if source_id is not None and target_id is not None:
                side = self._target_side(target_id, context)
                if side:
                    sides_by_source.setdefault(source_id, set()).add(side)
        context["mixed_target_sources"] = frozenset(
            source_id for source_id, sides in sides_by_source.items()
            if len(sides) > 1
        )

        def score(action: Action) -> tuple[int, ...]:
            kind = _action_type(action)
            if kind == ATTACK:
                return self._score_attack(action, context)
            if kind == PLAY_CARD:
                return self._score_play(action, context)
            if kind == USE_HERO_POWER:
                return self._score_hero_power(action, context)
            if kind == END_TURN:
                return (0, 0, 0, 0)
            return (-1, 0, 0, 0)

        best, best_score = _score_best(actions, score)
        assert best is not None and best_score is not None

        # END_TURN is the only neutral fallback.  If the observation cannot
        # establish any useful effect, avoid guessing at a hidden card rule.
        if best_score[0] <= 0:
            for action in actions:
                if _action_type(action) == END_TURN:
                    return action
        return best

    @staticmethod
    def _score_attack(action: Action, context: Mapping[str, Any]) -> tuple[int, ...]:
        source_id = _field(action, "source_entity_id")
        target_id = _field(action, "target_entity_id")
        hero = _mapping(context["hero"])
        opponent_hero = _mapping(context["opponent_hero"])

        if source_id == _entity_id(hero) and target_id == _entity_id(opponent_hero):
            attack = _integer(_field(hero, "atk"), 0) or 0
            target_total = (_integer(_field(opponent_hero, "health"), 0) or 0) + (
                _integer(_field(opponent_hero, "armor"), 0) or 0
            )
            if attack > 0 and attack >= target_total:
                return (1000, attack, 0, 0)
            if attack > 0:
                return (250, attack, 0, 0)
            return (-1, 0, 0, 0)

        source_is_hero = source_id == _entity_id(hero)
        source = hero if source_is_hero else _find_by_id(context["board"], _entity_id(source_id))
        if source and target_id == _entity_id(opponent_hero):
            attack = _integer(_field(source, "atk"), 0) or 0
            target_total = (_integer(_field(opponent_hero, "health"), 0) or 0) + (
                _integer(_field(opponent_hero, "armor"), 0) or 0
            )
            if attack > 0 and attack >= target_total:
                return (1000, attack, 0, 0)
            if attack > 0:
                return (250, attack, _integer(_field(source, "health"), 0) or 0, 0)
            return (-1, 0, 0, 0)

        target = _find_by_id(context["opponent_board"], _entity_id(target_id))
        if not source or not target:
            return (-1, 0, 0, 0)

        source_attack = _integer(_field(source, "atk"), 0) or 0
        source_health = _integer(_field(source, "health"), 0) or 0
        target_attack = _integer(_field(target, "atk"), 0) or 0
        target_health = _integer(_field(target, "health"), 0) or 0
        target_shield = bool(_field(target, "divine_shield", False))
        source_shield = bool(_field(source, "divine_shield", False))
        kills_target = source_attack > 0 and not target_shield and source_attack >= target_health
        survives = source_shield or target_attack < source_health
        target_value = target_attack + target_health
        source_value = source_attack + source_health

        if kills_target and survives:
            return (800, target_value, source_health - target_attack, source_attack)
        if kills_target and target_value > source_value:
            # A trade can still be useful when it removes a materially larger
            # visible threat, although it ranks below a surviving attacker.
            return (650, target_value - source_value, target_value, source_attack)
        if target_shield and source_attack > 0 and survives:
            return (300, -source_value, source_health, source_attack)
        return (-1, target_value, source_attack, 0)

    @staticmethod
    def _score_play(action: Action, context: Mapping[str, Any]) -> tuple[int, ...]:
        card = _find_by_id(context["hand"], _entity_id(_field(action, "source_entity_id")))
        if not card:
            return (-1, 0, 0, 0)
        cost = _integer(_field(card, "cost"))
        mana = context["mana"]
        if cost is not None and mana is not None and cost > mana:
            return (-1, 0, 0, 0)
        card_id = _field(card, "card_id")
        if card_id == "GIL_145" and cost == 0:
            # Echo can recreate the same legal action indefinitely at zero
            # mana cost; this baseline has no turn-level action budget.
            return (-1, 0, 0, 0)
        target_id = _entity_id(_field(action, "target_entity_id"))
        if target_id is not None:
            target_side = HeuristicAgent._target_side(target_id, context)
            if card_id in _FRIENDLY_TARGET_CARD_IDS and target_side != "friendly":
                return (-1, 0, 0, 0)
            if card_id in _OFFENSIVE_TARGET_CARD_IDS and target_side != "opponent":
                return (-1, 0, 0, 0)
        if (
            target_id is not None
            and _field(action, "source_entity_id") in context["mixed_target_sources"]
            and card_id not in _FRIENDLY_TARGET_CARD_IDS
            and card_id not in _OFFENSIVE_TARGET_CARD_IDS
        ):
            # The observation does not describe this card's effect.  When it
            # can target both sides, direction cannot be inferred safely.
            return (-1, 0, 0, 0)
        target_score = HeuristicAgent._score_target(action, context, card)
        if cost is None:
            return (500, 0, 0, *target_score)
        return (500, cost, -max(0, (mana or 0) - cost), *target_score)

    @staticmethod
    def _score_hero_power(action: Action, context: Mapping[str, Any]) -> tuple[int, ...]:
        power = context["hero_power"]
        if not power or _entity_id(power) != _field(action, "source_entity_id"):
            return (-1, 0, 0, 0)
        if _field(power, "is_usable", True) is False:
            return (-1, 0, 0, 0)
        card_id = _field(power, "card_id")
        hero = _mapping(context["hero"])
        if card_id in _LIFE_TAP_CARD_IDS:
            health = _integer(_field(hero, "health"), 0) or 0
            armor = _integer(_field(hero, "armor"), 0) or 0
            if health + armor <= 2:
                return (-1, 0, 0, 0)
            if _integer(_field(context, "deck_count")) == 0:
                return (-1, 0, 0, 0)
        if card_id in _HEAL_POWER_AMOUNTS:
            target_id = _entity_id(_field(action, "target_entity_id"))
            target = (
                hero if target_id == _entity_id(hero)
                else _find_by_id(context["board"], target_id)
            )
            missing = max(
                _integer(_field(target, "damage"), 0) or 0,
                (_integer(_field(target, "max_health"), 0) or 0)
                - (_integer(_field(target, "health"), 0) or 0),
            )
            if not target or missing <= 0:
                return (-1, 0, 0, 0)
            cost = _integer(_field(power, "cost"), 0) or 0
            return (400, min(missing, _HEAL_POWER_AMOUNTS[card_id]),
                    *HeuristicAgent._score_target(action, context, power))
        cost = _integer(_field(power, "cost"), 0) or 0
        return (400, cost, *HeuristicAgent._score_target(action, context, power))

    @staticmethod
    def _target_side(target_id: int, context: Mapping[str, Any]) -> str:
        if target_id == _entity_id(context["hero"]) or _find_by_id(
            context["board"], target_id
        ):
            return "friendly"
        if target_id == _entity_id(context["opponent_hero"]) or _find_by_id(
            context["opponent_board"], target_id
        ):
            return "opponent"
        return ""

    @staticmethod
    def _score_target(
        action: Action,
        context: Mapping[str, Any],
        source: Mapping[str, Any],
    ) -> tuple[int, ...]:
        """Prefer a visible opposing target when a command offers a choice.

        The agent cannot know a card's hidden effect from the observation.  A
        weak target preference prevents an offensive action from choosing the
        friendly hero merely because it appeared first.  Known healing and
        buff effects instead prefer friendly targets.  All targets still come
        from the controller's legal action list.
        """

        target_id = _entity_id(_field(action, "target_entity_id"))
        if target_id is None:
            return (0, 0, 0)
        friendly_target = _field(source, "card_id") in _FRIENDLY_TARGET_CARD_IDS
        opponent_hero = _mapping(context["opponent_hero"])
        if target_id == _entity_id(opponent_hero):
            return ((5 if friendly_target else 40),
                    _integer(_field(opponent_hero, "health"), 0) or 0, 0)
        opponent_target = _find_by_id(context["opponent_board"], target_id)
        if opponent_target:
            value = (_integer(_field(opponent_target, "atk"), 0) or 0) + (
                _integer(_field(opponent_target, "health"), 0) or 0
            )
            return ((10 if friendly_target else 50), value,
                    _integer(_field(opponent_target, "atk"), 0) or 0)
        own_hero = _mapping(context["hero"])
        if target_id == _entity_id(own_hero):
            return ((40 if friendly_target else 5),
                    _integer(_field(own_hero, "health"), 0) or 0, 0)
        own_target = _find_by_id(context["board"], target_id)
        if own_target:
            value = (_integer(_field(own_target, "atk"), 0) or 0) + (
                _integer(_field(own_target, "health"), 0) or 0
            )
            return ((50 if friendly_target else 20), value,
                    _integer(_field(own_target, "health"), 0) or 0)
        return (1, 0, 0)


__all__ = ["HeuristicAgent"]
