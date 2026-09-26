"""View-specific, JSON-safe projections of a Fireplace game.

The engine objects contain considerably more information than a player (or an
agent) should receive.  In particular, ``Player.dump_hidden`` still exposes
entity handles for cards in hidden zones.  This module therefore builds the
small observation value explicitly instead of delegating to ``dump``.

The public entry point is :func:`build_observation`.  It intentionally uses
duck-typed access to the game objects and does not import the controller; this
keeps the observation layer usable by controllers and by callers that only
have a partially initialised game.
"""

from hearthstone.enums import CardType


def _get(obj, name, default=None):
    """Read an attribute without making a partially built game unusable."""

    if obj is None:
        return default
    try:
        return getattr(obj, name)
    except Exception:
        # Card properties can depend on a controller, game, or data object
        # which is not present during construction and before mulligan.
        return default


def _call(obj, name, default=None):
    value = _get(obj, name, default)
    if callable(value):
        try:
            return value()
        except Exception:
            return default
    return value


def _enum_name(value):
    if value is None:
        return None
    name = _get(value, "name")
    if name:
        return str(name).upper()
    if isinstance(value, str):
        return value.upper()
    return None


def _int(value, default=0):
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _optional_int(value):
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _bool(value, default=False):
    if value is None:
        return default
    return bool(value)


def _text(value):
    """Return a JSON-safe textual card field."""

    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    try:
        return str(value)
    except Exception:
        return None


def _entity_id(entity):
    # Entity handles are deliberately emitted only for visible entities.
    return _optional_int(_get(entity, "entity_id"))


def _card_id(card):
    card_id = _get(card, "id")
    if card_id is None:
        data = _get(card, "data")
        card_id = _get(data, "id")
    return _text(card_id)


def _card_name(card):
    data = _get(card, "data")
    name = _get(data, "name")
    if name is None:
        name = _get(card, "name")
    if name is None:
        # BaseCard.__str__ returns the card's display name.  This fallback is
        # useful for lightweight test doubles and does not expose the object.
        try:
            name = str(card)
        except Exception:
            name = None
    return _text(name)


def _card_cost(card):
    cost = _get(card, "cost")
    if cost is None:
        data = _get(card, "data")
        cost = _get(data, "cost")
    return _optional_int(cost)


def _card_identity(card, include_cost=False):
    """The identity fields allowed for a card visible to this viewer."""

    result = {
        "entity_id": _entity_id(card),
        "card_id": _card_id(card),
        "name": _card_name(card),
    }
    if include_cost:
        result["cost"] = _card_cost(card)
    return result


def _visible_card_with_options(card, include_cost=False):
    result = _card_identity(card, include_cost=include_cost)
    if include_cost:
        # Only the viewer's hand uses this projection.  Compare the live card
        # values with the printed data so the UI can color changed numbers
        # without evaluating game rules or receiving Fireplace objects.
        data = _get(card, "data")
        result["printed_cost"] = _optional_int(_get(data, "cost"))
        result["powered_up"] = _bool(_get(card, "powered_up"))
        card_type = _get(card, "type", _get(data, "type"))
        if card_type in (CardType.MINION, CardType.WEAPON):
            result["atk"] = _optional_int(_get(card, "atk"))
            result["printed_atk"] = _optional_int(_get(data, "atk"))
        if card_type == CardType.MINION:
            result["max_health"] = _optional_int(_get(card, "max_health"))
            result["printed_health"] = _optional_int(_get(data, "health"))
        elif card_type == CardType.WEAPON:
            result["durability"] = _optional_int(_get(card, "durability"))
            result["printed_durability"] = _optional_int(_get(data, "durability"))
    options = _cards(_get(card, "choose_cards"))
    if options:
        result["choose_options"] = [_card_identity(option) for option in options]
    return result


def _character(card, include_position=False):
    """Project a publicly visible hero or minion."""

    dormant = _bool(_get(card, "dormant"))
    result = _card_identity(card)
    result.update(
        {
            "atk": _int(_get(card, "atk")),
            "health": _int(_get(card, "health")),
            "max_health": _int(_get(card, "max_health")),
            "damage": _int(_get(card, "damage")),
            "armor": _int(_get(card, "armor")),
            "taunt": _bool(_get(card, "taunt")),
            "divine_shield": _bool(_get(card, "divine_shield")),
            "frozen": _bool(_get(card, "frozen")),
            "stealthed": _bool(_get(card, "stealthed")),
            "poisonous": _bool(_get(card, "poisonous")),
            "dormant": dormant,
            "lifesteal": _bool(_get(card, "lifesteal")),
            "reborn": _bool(_get(card, "reborn")),
            "windfury": _bool(_get(card, "windfury")),
            "rush": _bool(_get(card, "rush")),
            "charge": _bool(_get(card, "charge")),
            "silenced": _bool(_get(card, "silenced")),
            "can_attack": _bool(_call(card, "can_attack")),
        }
    )
    if dormant:
        # Fireplace keeps this as the number of turns remaining.  It can be
        # stale or malformed on lightweight objects, so never expose a
        # negative countdown and do not publish it for awake characters.
        result["dormant_turns"] = max(0, _int(_get(card, "dormant_turns")))
    if include_position:
        result["zone_position"] = _int(_get(card, "zone_position"))
    return result


def _weapon(card):
    if card is None:
        return None
    result = _card_identity(card)
    result.update(
        {
            "atk": _int(_get(card, "atk")),
            "durability": _int(_get(card, "durability")),
            "max_durability": _int(_get(card, "max_durability")),
            "damage": _int(_get(card, "damage")),
            "exhausted": _bool(_get(card, "exhausted")),
        }
    )
    return result


def _hero_power(card):
    if card is None:
        return None
    result = _card_identity(card, include_cost=True)
    result.update(
        {
            "is_usable": _bool(_call(card, "is_usable")),
            "exhausted": _bool(_get(card, "exhausted")),
        }
    )
    return result


def _cards(value):
    if value is None:
        return []
    try:
        return list(value)
    except (TypeError, ValueError):
        return []


def _count(value):
    try:
        return len(value)
    except (TypeError, ValueError):
        return 0


def _player_projection(player, include_private):
    hero = _get(player, "hero")
    hero_power = _get(player, "hero_power")
    if hero_power is None:
        hero_power = _get(hero, "power")

    field = _cards(_get(player, "field"))
    deck = _get(player, "deck")
    hand = _cards(_get(player, "hand"))
    secrets = _cards(_get(player, "secrets"))

    result = {
        "hero": _character(hero) if hero is not None else None,
        "board": [_character(card, include_position=True) for card in field],
        "weapon": _weapon(_get(player, "weapon")),
        "hero_power": _hero_power(hero_power),
        "mana": _int(_get(player, "mana")),
        "max_mana": _int(_get(player, "max_mana")),
        "deck_count": _count(deck),
    }
    if include_private:
        result["hand"] = [
            _visible_card_with_options(card, include_cost=True) for card in hand
        ]
        if hero_power is not None:
            result["hero_power"] = _hero_power(hero_power)
            options = _cards(_get(hero_power, "choose_cards"))
            if options:
                result["hero_power"]["choose_options"] = [
                    _card_identity(option) for option in options
                ]
        result["secrets"] = [
            _card_identity(card, include_cost=True) for card in secrets
        ]
    else:
        result["hand_count"] = len(hand)
        result["secrets_count"] = len(secrets)
    return result


def _is_mulligan_choice(choice):
    if choice is None:
        return False
    # Importing actions here would be unnecessary coupling for a projection
    # helper.  The engine's mulligan action has a stable class name and is
    # present in both normal and partially initialised games.
    return _get(choice, "__class__").__name__ == "MulliganChoice"


def _is_game_over(game):
    ended = _get(game, "ended", False)
    if callable(ended):
        ended = _call(game, "ended", False)
    if ended:
        return True
    return _enum_name(_get(game, "state")) == "COMPLETE"


def _normalise_phase(phase):
    if phase is None:
        return None
    if isinstance(phase, str):
        return phase.upper()
    name = _enum_name(phase)
    if name:
        return name
    return _text(phase)


def _phase_for(game, viewer, players, phase):
    explicit = _normalise_phase(phase)
    if explicit is not None:
        return explicit
    if _is_game_over(game):
        return "GAME_OVER"

    choices = [_get(player, "choice") for player in players]
    if any(_is_mulligan_choice(choice) for choice in choices):
        return "MULLIGAN"
    if _get(viewer, "choice") is not None or any(choice for choice in choices):
        return "CHOICE"

    step = _enum_name(_get(game, "step"))
    if step == "BEGIN_MULLIGAN":
        return "MULLIGAN"

    # A freshly constructed Game has no current player yet and is still before
    # the mulligan phase.  MULLIGAN is the closest public phase in the small
    # observation schema and keeps this state useful to callers.
    if _get(game, "current_player") is None:
        return "MULLIGAN"
    return "MAIN"


def _seat(players, player):
    for index, candidate in enumerate(players):
        if candidate is player:
            return index
    return None


def _active_seat(game, players, phase):
    if phase == "GAME_OVER":
        return None

    if phase in ("MULLIGAN", "CHOICE"):
        for player in players:
            choice = _get(player, "choice")
            if choice is not None and (phase != "MULLIGAN" or _is_mulligan_choice(choice)):
                return _seat(players, player)

    current = _get(game, "current_player")
    current_seat = _seat(players, current)
    if current_seat is not None:
        return current_seat

    return None


def _opponent(players, viewer):
    for player in players:
        if player is not viewer:
            return player
    return None


def _pending_choice(viewer):
    choice = _get(viewer, "choice")
    if choice is None:
        return None
    result = {
        "options": [
            _card_identity(card, include_cost=True)
            for card in _cards(_get(choice, "cards"))
        ]
    }
    minimum = _get(choice, "min_count")
    maximum = _get(choice, "max_count")
    if minimum is not None:
        result["min_count"] = _int(minimum)
    if maximum is not None:
        result["max_count"] = _int(maximum)
    return result


def build_observation(game, viewer, phase=None):
    """Return the JSON-safe observation visible to ``viewer``.

    ``viewer`` must be one of ``game.players``.  Public entities (heroes,
    board cards, weapons, and hero powers) carry their visible entity handle
    and card identity.  The viewer's hand, secrets, and pending choice are
    projected with the same explicit card whitelist; the opponent receives
    only hand/secret counts and no hidden card handles or IDs.

    The returned schema is::

        {
            "turn": int,
            "phase": "MAIN" | "MULLIGAN" | "CHOICE" | "GAME_OVER",
            "active_seat": int | None,
            "self": {..., "hand": [...], "secrets": [...]},
            "opponent": {..., "hand_count": int, "secrets_count": int},
            "pending_choice": {"options": [...], ...} | None,
        }

    No value in this mapping is a Fireplace object, enum, or callback.
    """

    players = _cards(_get(game, "players"))
    if viewer not in players:
        raise ValueError("viewer must be one of game.players")

    opponent = _opponent(players, viewer)
    resolved_phase = _phase_for(game, viewer, players, phase)
    return {
        "turn": _int(_get(game, "turn")),
        "phase": resolved_phase,
        "active_seat": _active_seat(game, players, resolved_phase),
        "self": _player_projection(viewer, include_private=True),
        "opponent": _player_projection(opponent, include_private=False),
        "pending_choice": _pending_choice(viewer),
    }
