"""Agents that make decisions through the Fireplace value-object boundary.

The agents in this module deliberately do not receive a ``Game`` or a
``Player``.  ``GameSession`` owns translating an :class:`Action` back into an
engine operation; agents only choose from the already validated actions that
it gives them.
"""

from __future__ import annotations

import random
import sys
from pprint import pformat
from typing import Callable, TextIO

from .agent_api import Action
from .heuristic_agent import HeuristicAgent


class UserQuit(Exception):
    """Raised when a human asks the surrounding game application to quit."""


def _action_type(action: Action) -> str:
    """Return an action type suitable for display and comparisons."""

    value = action.type
    # Keep this tolerant of a future string Enum while the public Action API
    # remains serializable as a plain string.
    value = getattr(value, "value", value)
    return str(value).upper()


def _action_value(action: Action, name: str, default=None):
    """Read a field from an Action without requiring a particular dataclass.

    The production Action is a dataclass, but using ``getattr`` here also
    makes the presentation and random policy easy to exercise with small
    value-object doubles.
    """

    return getattr(action, name, default)


class RandomAgent:
    """Choose a legal action at random.

    A pure random player can spend a very long time playing cheap actions
    without ending its turn.  When ``END_TURN`` is available this policy gives
    it a configurable chance of being selected, while still sampling all
    other legal actions when it does not end the turn.
    """

    def __init__(
        self,
        seed: int | None = None,
        *,
        rng: random.Random | None = None,
        end_turn_probability: float = 0.35,
    ):
        if rng is not None and seed is not None:
            raise ValueError("Pass either seed or rng, not both")
        if not 0.0 <= end_turn_probability <= 1.0:
            raise ValueError("end_turn_probability must be between 0 and 1")
        self.random = rng if rng is not None else random.Random(seed)
        self.end_turn_probability = end_turn_probability

    def choose_action(
        self, observation: dict, legal_actions: list[Action]
    ) -> Action:
        """Return one of ``legal_actions`` without inspecting engine state."""

        del observation  # The baseline policy does not need the projection.
        actions = list(legal_actions)
        if not actions:
            raise ValueError("RandomAgent received no legal actions")

        end_turn = [action for action in actions if _action_type(action) == "END_TURN"]
        if len(actions) > len(end_turn) and end_turn:
            if self.random.random() < self.end_turn_probability:
                return self.random.choice(end_turn)
            actions = [action for action in actions if action not in end_turn]

        # This also covers a phase containing only END_TURN and all ordinary
        # action types, including CHOOSE and MULLIGAN subsets.
        return self.random.choice(actions)


class HumanTUIAgent:
    """A small standard-library terminal agent.

    The agent renders only the observation and legal value actions supplied by
    ``GameSession``.  It never resolves IDs or calls Fireplace methods itself;
    the session remains the sole action executor.
    """

    def __init__(
        self,
        *,
        input_fn: Callable[[str], str] = input,
        output: TextIO | None = None,
    ):
        self.input_fn = input_fn
        self.output = output if output is not None else sys.stdout

    def _write(self, text: str = "") -> None:
        print(text, file=self.output)

    def on_action_error(self, reason: str) -> None:
        self._write("Action unavailable: %s. Refreshing choices." % reason)

    @staticmethod
    def _visible_entity_labels(observation: dict) -> dict[int, str]:
        """Collect friendly labels from the already filtered observation.

        This function walks only dictionaries/lists in the observation.  It
        does not resolve an ID through the engine and therefore cannot reveal
        an opponent's hidden cards on its own.
        """

        labels: dict[int, str] = {}

        def visit(value) -> None:
            if isinstance(value, dict):
                entity_id = value.get("entity_id")
                if isinstance(entity_id, int):
                    card_id = value.get("card_id") or value.get("id")
                    name = value.get("name") or card_id
                    if name is not None:
                        labels[entity_id] = str(name)
                for child in value.values():
                    visit(child)
            elif isinstance(value, (list, tuple)):
                for child in value:
                    visit(child)

        visit(observation)
        return labels

    @staticmethod
    def _format_entity(entity_id, labels: dict[int, str]) -> str:
        if entity_id is None:
            return "-"
        try:
            label = labels.get(int(entity_id))
        except (TypeError, ValueError):
            label = None
        if label:
            return "%s (%s)" % (entity_id, label)
        return str(entity_id)

    @classmethod
    def _describe_action(cls, action: Action, labels: dict[int, str]) -> str:
        """Create a compact, readable line for a legal action."""

        kind = _action_type(action)
        if kind == "END_TURN":
            return "END_TURN"
        if kind == "MULLIGAN":
            selected = _action_value(action, "mulligan_entity_ids", ()) or ()
            if not selected:
                return "MULLIGAN: keep all cards"
            cards = ", ".join(
                cls._format_entity(card_id, labels) for card_id in selected
            )
            return "MULLIGAN: replace %s" % cards
        if kind == "CHOOSE":
            choice_id = _action_value(action, "choice_entity_id")
            return "CHOOSE: %s" % cls._format_entity(choice_id, labels)
        if kind == "PLAY_CARD":
            source = cls._format_entity(
                _action_value(action, "source_entity_id"), labels
            )
            target_id = _action_value(action, "target_entity_id")
            branch_id = _action_value(action, "choose_option_entity_id")
            details = ["PLAY_CARD: %s" % source]
            if branch_id is not None:
                details.append("option=%s" % cls._format_entity(branch_id, labels))
            if target_id is not None:
                details.append("target=%s" % cls._format_entity(target_id, labels))
            position = _action_value(action, "position")
            if position is not None:
                details.append("position=%s" % position)
            return ", ".join(details)
        if kind == "ATTACK":
            source = cls._format_entity(
                _action_value(action, "source_entity_id"), labels
            )
            target = cls._format_entity(
                _action_value(action, "target_entity_id"), labels
            )
            return "ATTACK: %s -> %s" % (source, target)
        if kind == "USE_HERO_POWER":
            source = cls._format_entity(
                _action_value(action, "source_entity_id"), labels
            )
            target_id = _action_value(action, "target_entity_id")
            branch_id = _action_value(action, "choose_option_entity_id")
            details = ["USE_HERO_POWER: %s" % source]
            if branch_id is not None:
                details.append("option=%s" % cls._format_entity(branch_id, labels))
            if target_id is not None:
                details.append("target=%s" % cls._format_entity(target_id, labels))
            return ", ".join(details)

        # Keep unknown future action types usable in the TUI.  ``to_dict`` is
        # the public value representation and contains no engine references.
        try:
            details = action.to_dict()
        except AttributeError:
            details = repr(action)
        return "%s: %s" % (kind, details)

    def _show(self, observation: dict, legal_actions: list[Action]) -> None:
        phase = (
            observation.get("phase", "UNKNOWN")
            if isinstance(observation, dict)
            else "UNKNOWN"
        )
        self._write("\n=== Fireplace | %s ===" % phase)
        # Observations are already privacy-filtered by the controller.  Keep
        # this rendering generic so new public fields remain visible without
        # requiring a second engine-facing view in the TUI.
        self._write(pformat(observation, sort_dicts=False))

        labels = self._visible_entity_labels(observation)
        self._write("Legal actions:")
        for number, action in enumerate(legal_actions, 1):
            self._write("  %d. %s" % (number, self._describe_action(action, labels)))

    def choose_action(
        self, observation: dict, legal_actions: list[Action]
    ) -> Action:
        """Display the current decision and retry until a valid number is read."""

        actions = list(legal_actions)
        if not actions:
            raise ValueError("HumanTUIAgent received no legal actions")

        self._show(observation, actions)
        while True:
            try:
                raw = self.input_fn("Select an action [1-%d]: " % len(actions))
            except EOFError:
                self._write("Input closed while waiting for an action.")
                raise
            if isinstance(raw, str) and raw.strip().lower() in {"q", "quit"}:
                raise UserQuit
            try:
                number = int(raw.strip())
            except (AttributeError, TypeError, ValueError):
                self._write("Invalid input: enter an action number.")
                continue
            if 1 <= number <= len(actions):
                return actions[number - 1]
            self._write("Invalid input: choose a number from 1 to %d." % len(actions))


__all__ = ["HeuristicAgent", "HumanTUIAgent", "RandomAgent", "UserQuit"]
