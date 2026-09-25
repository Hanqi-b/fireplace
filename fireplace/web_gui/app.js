(function () {
  "use strict";

  const API_STATE = "/api/state";
  const API_ACTION = "/api/action";
  const ACTION_ORDER = [
    "MULLIGAN",
    "CHOOSE",
    "PLAY_CARD",
    "ATTACK",
    "USE_HERO_POWER",
    "END_TURN",
  ];

  const elements = {};
  let snapshot = null;
  let busy = false;
  let noticeTimer = null;

  function getElement(id) {
    return document.getElementById(id);
  }

  function init() {
    [
      "phase-value",
      "turn-value",
      "active-seat-value",
      "revision-value",
      "notice",
      "opponent-hand-count",
      "opponent-mana-value",
      "opponent-hand",
      "opponent-hero-row",
      "opponent-board-count",
      "opponent-board",
      "self-hero-row",
      "self-board-count",
      "self-board",
      "hero-power-row",
      "mana-value",
      "hand",
      "deck-count",
      "action-count",
      "action-instructions",
      "pending-choice",
      "action-menu",
      "connection-value",
    ].forEach(function (id) {
      elements[id] = getElement(id);
    });
    loadState();
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function asArray(value) {
    if (Array.isArray(value)) {
      return value;
    }
    if (value && typeof value.length === "number") {
      return Array.from(value);
    }
    return [];
  }

  function safeNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function safeText(value, fallback) {
    if (value === null || value === undefined || value === "") {
      return fallback || "";
    }
    return String(value);
  }

  function cardName(card) {
    if (!isObject(card)) {
      return "Unknown card";
    }
    return safeText(card.name, safeText(card.card_id, "Unknown card"));
  }

  function entityKey(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function labelForEntity(entityId) {
    const key = entityKey(entityId);
    if (key === null) {
      return "—";
    }
    const labels = entityLabels();
    return labels.get(key) || "Entity #" + String(key);
  }

  function addEntityLabel(labels, entity, label) {
    if (!isObject(entity)) {
      return;
    }
    const key = entityKey(entity.entity_id);
    if (key !== null) {
      labels.set(key, label || cardName(entity));
    }
  }

  function entityLabels() {
    const labels = new Map();
    if (!snapshot || !isObject(snapshot.observation)) {
      return labels;
    }
    const observation = snapshot.observation;
    const self = isObject(observation.self) ? observation.self : {};
    const opponent = isObject(observation.opponent) ? observation.opponent : {};

    addEntityLabel(labels, self.hero, "Your hero: " + cardName(self.hero));
    addEntityLabel(labels, self.hero_power, "Your power: " + cardName(self.hero_power));
    addEntityLabel(labels, opponent.hero, "Opponent hero: " + cardName(opponent.hero));
    addEntityLabel(labels, opponent.hero_power, "Opponent power: " + cardName(opponent.hero_power));
    asArray(self.hand).forEach(function (card) {
      addEntityLabel(labels, card, cardName(card));
      asArray(card.choose_options).forEach(function (option) {
        addEntityLabel(labels, option, cardName(option));
      });
    });
    asArray(self.board).forEach(function (card) {
      addEntityLabel(labels, card, cardName(card));
    });
    asArray(opponent.board).forEach(function (card) {
      addEntityLabel(labels, card, "Opponent: " + cardName(card));
    });
    const pending = isObject(observation.pending_choice) ? observation.pending_choice : {};
    asArray(pending.options).forEach(function (option) {
      addEntityLabel(labels, option, cardName(option));
    });
    if (isObject(self.hero_power)) {
      asArray(self.hero_power.choose_options).forEach(function (option) {
        addEntityLabel(labels, option, cardName(option));
      });
    }
    return labels;
  }

  function setText(node, value) {
    if (node) {
      node.textContent = safeText(value, "");
    }
  }

  function clear(node) {
    if (!node) {
      return;
    }
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function setHidden(node, hidden) {
    if (node) {
      node.hidden = Boolean(hidden);
    }
  }

  function setConnection(text, isError) {
    setText(elements["connection-value"], text);
    if (elements["connection-value"]) {
      elements["connection-value"].style.color = isError ? "var(--danger)" : "";
    }
  }

  function showNotice(message, kind, timeout) {
    if (!elements.notice) {
      return;
    }
    window.clearTimeout(noticeTimer);
    elements.notice.className = "notice" + (kind ? " " + kind : "");
    setText(elements.notice, message);
    setHidden(elements.notice, !message);
    if (timeout) {
      noticeTimer = window.setTimeout(function () {
        setHidden(elements.notice, true);
      }, timeout);
    }
  }

  function loadState() {
    setConnection("Loading…", false);
    fetch(API_STATE, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(readJsonResponse)
      .then(function (payload) {
        const next = snapshotFromPayload(payload);
        if (!next) {
          throw new Error("The state response is missing a game snapshot.");
        }
        applySnapshot(next);
        setConnection("Connected", false);
        if (next.observation.phase !== "GAME_OVER") {
          showNotice("", "", 0);
        }
      })
      .catch(function (error) {
        setConnection("Disconnected", true);
        showNotice("Could not load the local game: " + errorMessage(error), "error", 0);
        renderEmptyState();
      });
  }

  function readJsonResponse(response) {
    return response.text().then(function (body) {
      let payload = {};
      if (body) {
        try {
          payload = JSON.parse(body);
        } catch (error) {
          throw new Error("The server returned invalid JSON (HTTP " + response.status + ").");
        }
      }
      if (!response.ok) {
        const failure = new Error(errorMessage(payload.error) || ("HTTP " + response.status));
        failure.payload = payload;
        failure.status = response.status;
        throw failure;
      }
      return payload;
    });
  }

  function errorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    if (isObject(error) && typeof error.message === "string") {
      return error.message;
    }
    return "Unknown error";
  }

  function snapshotFromPayload(payload) {
    if (!isObject(payload)) {
      return null;
    }
    if (isObject(payload.snapshot)) {
      return snapshotFromPayload(payload.snapshot);
    }
    if (!isObject(payload.observation) || !Array.isArray(payload.legal_actions)) {
      return null;
    }
    return {
      revision: safeNumber(payload.revision, 0),
      observation: payload.observation,
      legal_actions: payload.legal_actions,
      outcome: payload.outcome === undefined ? null : payload.outcome,
    };
  }

  function applySnapshot(next) {
    snapshot = next;
    renderSnapshot();
  }

  function renderEmptyState() {
    setText(elements["phase-value"], "Unavailable");
    setText(elements["turn-value"], "Turn —");
    setText(elements["active-seat-value"], "Active seat —");
    setText(elements["revision-value"], "Revision —");
    clear(elements["action-menu"]);
    clear(elements["hand"]);
    clear(elements["self-board"]);
    clear(elements["opponent-board"]);
    clear(elements["self-hero-row"]);
    clear(elements["opponent-hero-row"]);
    clear(elements["hero-power-row"]);
  }

  function renderSnapshot() {
    const observation = isObject(snapshot.observation) ? snapshot.observation : {};
    const self = isObject(observation.self) ? observation.self : {};
    const opponent = isObject(observation.opponent) ? observation.opponent : {};
    const phase = safeText(observation.phase, "UNKNOWN").toUpperCase();
    const turn = observation.turn;

    setText(elements["phase-value"], phase);
    setText(elements["turn-value"], turn === null || turn === undefined ? "Turn —" : "Turn " + String(turn));
    const activeSeat = observation.active_seat;
    setText(
      elements["active-seat-value"],
      activeSeat === null || activeSeat === undefined ? "Active seat —" : "Active seat " + String(activeSeat),
    );
    setText(elements["revision-value"], "Revision " + String(snapshot.revision));
    setText(elements["mana-value"], manaText(self));
    setText(elements["opponent-mana-value"], manaText(opponent));
    setText(elements["opponent-hand-count"], String(safeNumber(opponent.hand_count, 0)) + " cards");
    setText(elements["deck-count"], String(safeNumber(self.deck_count, 0)) + " in deck");
    setText(elements["self-board-count"], boardCountText(self.board));
    setText(elements["opponent-board-count"], boardCountText(opponent.board));
    setText(elements["action-count"], String(asArray(snapshot.legal_actions).length) + " legal");

    renderHiddenHand(opponent.hand_count);
    renderHero(elements["opponent-hero-row"], opponent.hero, false);
    renderHero(elements["self-hero-row"], self.hero, true);
    renderBoard(elements["opponent-board"], opponent.board, false);
    renderBoard(elements["self-board"], self.board, true);
    renderHeroPower(self.hero_power);
    renderHand(self.hand, snapshot.legal_actions);
    renderPendingChoice(observation.pending_choice);
    renderActions(snapshot.legal_actions);
    renderOutcome(snapshot.outcome, phase);
  }

  function manaText(player) {
    const mana = player && player.mana !== undefined ? player.mana : "—";
    const maxMana = player && player.max_mana !== undefined ? player.max_mana : "—";
    return String(mana) + " / " + String(maxMana) + " mana";
  }

  function boardCountText(board) {
    const count = asArray(board).length;
    return count + (count === 1 ? " minion" : " minions");
  }

  function renderHiddenHand(count) {
    clear(elements["opponent-hand"]);
    const amount = Math.max(0, safeNumber(count, 0));
    for (let index = 0; index < amount; index += 1) {
      const card = document.createElement("span");
      card.className = "hidden-card";
      card.setAttribute("aria-label", "Hidden opponent card " + String(index + 1));
      elements["opponent-hand"].appendChild(card);
    }
  }

  function renderHero(container, hero, own) {
    clear(container);
    if (!isObject(hero)) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No hero data";
      container.appendChild(empty);
      return;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "hero-card";
    wrapper.appendChild(createCardArt(hero, "render"));

    const copy = document.createElement("div");
    copy.className = "hero-copy";
    const title = document.createElement("p");
    title.className = "card-name";
    title.textContent = cardName(hero);
    copy.appendChild(title);
    const subtitle = document.createElement("p");
    subtitle.className = "card-subtitle";
    subtitle.textContent = own ? "Your hero" : "Opponent hero";
    copy.appendChild(subtitle);
    copy.appendChild(createCharacterStats(hero, true));
    wrapper.appendChild(copy);
    container.appendChild(wrapper);
  }

  function createCharacterStats(character, includeAttack) {
    const stats = document.createElement("div");
    stats.className = "stats";
    if (includeAttack && character.atk !== undefined) {
      stats.appendChild(createStat("attack", "ATK", character.atk));
    }
    if (character.health !== undefined) {
      const health = character.max_health !== undefined && character.max_health !== null
        ? String(character.health) + " / " + String(character.max_health)
        : character.health;
      stats.appendChild(createStat("health", "HP", health));
    }
    if (character.armor !== undefined) {
      stats.appendChild(createStat("armor", "ARM", character.armor));
    }
    if (character.frozen) {
      stats.appendChild(createBadge("Frozen"));
    }
    return stats;
  }

  function createStat(kind, label, value) {
    const stat = document.createElement("span");
    stat.className = "stat " + kind;
    const strong = document.createElement("strong");
    strong.textContent = safeText(value, "—");
    stat.appendChild(strong);
    const suffix = document.createElement("span");
    suffix.textContent = label;
    stat.appendChild(suffix);
    return stat;
  }

  function createBadge(text, extraClass) {
    const badge = document.createElement("span");
    badge.className = "badge" + (extraClass ? " " + extraClass : "");
    badge.textContent = safeText(text, "");
    return badge;
  }

  function renderBoard(container, board, own) {
    clear(container);
    asArray(board).forEach(function (card) {
      const node = createBoardCard(card, own);
      container.appendChild(node);
    });
  }

  function createBoardCard(card, own) {
    const wrapper = document.createElement("article");
    wrapper.className = "card board-card";
    wrapper.setAttribute("aria-label", cardName(card));
    wrapper.appendChild(createCardArt(card, "render"));
    const content = document.createElement("div");
    content.className = "card-content";
    const title = document.createElement("p");
    title.className = "card-name";
    title.textContent = cardName(card);
    content.appendChild(title);
    const badges = document.createElement("div");
    badges.className = "card-badges";
    if (card.atk !== undefined) {
      badges.appendChild(createBadge(card.atk + " ATK", "attack"));
    }
    if (card.health !== undefined) {
      badges.appendChild(createBadge(card.health + " HP", "health"));
    }
    if (card.taunt) {
      badges.appendChild(createBadge("Taunt"));
    }
    if (card.can_attack) {
      badges.appendChild(createBadge("Ready"));
    }
    if (card.zone_position !== undefined && own) {
      badges.appendChild(createBadge("slot " + String(card.zone_position)));
    }
    content.appendChild(badges);
    wrapper.appendChild(content);
    return wrapper;
  }

  function createCardArt(card, kind) {
    const art = document.createElement("div");
    art.className = "card-art";
    const cardId = isObject(card) ? card.card_id : null;
    if (cardId) {
      const image = document.createElement("img");
      image.alt = cardName(card) + " local artwork";
      image.loading = "lazy";
      image.src = "/assets/" + encodeURIComponent(kind || "render") + "/" + encodeURIComponent(String(cardId));
      image.addEventListener("error", function () {
        image.hidden = true;
        art.classList.add("asset-placeholder");
      });
      art.appendChild(image);
    } else {
      art.classList.add("asset-placeholder");
    }
    return art;
  }

  function renderHeroPower(power) {
    clear(elements["hero-power-row"]);
    if (!isObject(power)) {
      return;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "power-card";
    wrapper.appendChild(createCardArt(power, "render"));
    const copy = document.createElement("div");
    const title = document.createElement("p");
    title.className = "card-name";
    title.textContent = "Hero power: " + cardName(power);
    copy.appendChild(title);
    const details = document.createElement("p");
    details.className = "card-subtitle";
    details.textContent = power.is_usable ? "Usable" : (power.exhausted ? "Exhausted" : "Unavailable");
    copy.appendChild(details);
    wrapper.appendChild(copy);
    elements["hero-power-row"].appendChild(wrapper);
  }

  function renderHand(hand, actions) {
    clear(elements["hand"]);
    const actionSources = new Set();
    asArray(actions).forEach(function (action) {
      if (isObject(action) && (action.type === "PLAY_CARD" || action.type === "USE_HERO_POWER")) {
        const source = entityKey(action.source_entity_id);
        if (source !== null) {
          actionSources.add(source);
        }
      }
    });
    asArray(hand).forEach(function (card) {
      const node = createHandCard(card, actionSources.has(entityKey(card && card.entity_id)));
      elements["hand"].appendChild(node);
    });
  }

  function createHandCard(card, actionable) {
    const wrapper = document.createElement("article");
    wrapper.className = "card hand-card" + (actionable ? " actionable" : "");
    wrapper.setAttribute("aria-label", cardName(card));
    if (actionable) {
      wrapper.tabIndex = 0;
      wrapper.title = "Find this card in the legal action list below";
      wrapper.addEventListener("click", function () {
        focusActionsForSource(card.entity_id);
      });
      wrapper.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          focusActionsForSource(card.entity_id);
        }
      });
    }
    const art = createCardArt(card, "render");
    if (card && card.cost !== undefined && card.cost !== null) {
      art.appendChild(createBadge(card.cost, "cost"));
    }
    wrapper.appendChild(art);
    const content = document.createElement("div");
    content.className = "card-content";
    const title = document.createElement("p");
    title.className = "card-name";
    title.textContent = cardName(card);
    content.appendChild(title);
    if (card && card.choose_options && card.choose_options.length) {
      content.appendChild(createBadge("Choose one"));
    }
    wrapper.appendChild(content);
    return wrapper;
  }

  function focusActionsForSource(entityId) {
    const oldReset = elements["action-menu"].querySelector(".reset-action-filter");
    if (oldReset) {
      oldReset.remove();
    }
    const buttons = asArray(elements["action-menu"].querySelectorAll("button[data-source-id]"));
    let first = null;
    buttons.forEach(function (button) {
      const matches = String(button.dataset.sourceId) === String(entityId);
      button.hidden = !matches;
      if (matches && !first) {
        first = button;
      }
    });
    if (first) {
      first.focus();
      showNotice("Showing legal actions for " + labelForEntity(entityId) + ". Select an action below.", "", 4000);
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "action-button reset-action-filter";
      reset.textContent = "Show all legal actions";
      reset.addEventListener("click", function () {
        asArray(elements["action-menu"].querySelectorAll(".action-button")).forEach(function (button) {
          button.hidden = false;
        });
        reset.remove();
      });
      elements["action-menu"].prepend(reset);
    }
  }

  function renderPendingChoice(choice) {
    clear(elements["pending-choice"]);
    if (!isObject(choice)) {
      setHidden(elements["pending-choice"], true);
      return;
    }
    const options = asArray(choice.options).map(cardName).join(", ");
    const text = document.createElement("span");
    const bounds = [];
    if (choice.min_count !== undefined) {
      bounds.push("minimum " + String(choice.min_count));
    }
    if (choice.max_count !== undefined) {
      bounds.push("maximum " + String(choice.max_count));
    }
    text.textContent = "Pending choice: " + (options || "select from the legal actions") + (bounds.length ? " (" + bounds.join(", ") + ")" : "");
    elements["pending-choice"].appendChild(text);
    setHidden(elements["pending-choice"], false);
  }

  function renderActions(actions) {
    clear(elements["action-menu"]);
    const groups = new Map();
    asArray(actions).forEach(function (action, index) {
      const type = isObject(action) ? safeText(action.type, "UNKNOWN") : "UNKNOWN";
      if (!groups.has(type)) {
        groups.set(type, []);
      }
      groups.get(type).push({ action: action, index: index });
    });

    const types = Array.from(groups.keys()).sort(function (left, right) {
      const leftIndex = ACTION_ORDER.indexOf(left);
      const rightIndex = ACTION_ORDER.indexOf(right);
      return (leftIndex < 0 ? ACTION_ORDER.length : leftIndex) - (rightIndex < 0 ? ACTION_ORDER.length : rightIndex);
    });

    if (!types.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = snapshot && snapshot.outcome ? "The game is over." : "No action is currently available.";
      elements["action-menu"].appendChild(empty);
      setText(elements["action-instructions"], snapshot && snapshot.outcome ? "This session has ended." : "Waiting for the server to provide a decision.");
      return;
    }

    setText(elements["action-instructions"], "Each button submits the exact action value supplied by the server.");
    types.forEach(function (type) {
      const group = document.createElement("section");
      group.className = "action-group";
      const heading = document.createElement("div");
      heading.className = "action-group-title";
      const title = document.createElement("span");
      title.textContent = type;
      heading.appendChild(title);
      const count = document.createElement("span");
      count.textContent = String(groups.get(type).length);
      heading.appendChild(count);
      group.appendChild(heading);
      const list = document.createElement("div");
      list.className = "action-list";
      groups.get(type).forEach(function (item) {
        list.appendChild(createActionButton(item.action, item.index));
      });
      group.appendChild(list);
      elements["action-menu"].appendChild(group);
    });
  }

  function createActionButton(action, index) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "action-button";
    button.dataset.actionIndex = String(index);
    if (isObject(action) && action.source_entity_id !== undefined) {
      button.dataset.sourceId = String(action.source_entity_id);
    }
    const label = document.createElement("span");
    label.className = "action-label";
    label.textContent = actionLabel(action);
    button.appendChild(label);
    const detail = document.createElement("code");
    detail.className = "action-detail";
    detail.textContent = actionDetail(action);
    button.appendChild(detail);
    button.addEventListener("click", function () {
      submitAction(index);
    });
    return button;
  }

  function actionLabel(action) {
    if (!isObject(action)) {
      return "Unknown action";
    }
    const type = safeText(action.type, "ACTION");
    if (type === "MULLIGAN") {
      const ids = asArray(action.mulligan_entity_ids);
      return ids.length ? "Replace " + ids.map(labelForEntity).join(", ") : "Keep all cards";
    }
    if (type === "CHOOSE") {
      return "Choose " + labelForEntity(action.choice_entity_id);
    }
    if (type === "PLAY_CARD") {
      return "Play " + labelForEntity(action.source_entity_id);
    }
    if (type === "ATTACK") {
      return "Attack " + labelForEntity(action.target_entity_id);
    }
    if (type === "USE_HERO_POWER") {
      return "Use " + labelForEntity(action.source_entity_id);
    }
    if (type === "END_TURN") {
      return "End turn";
    }
    return type;
  }

  function actionDetail(action) {
    if (!isObject(action)) {
      return "";
    }
    const details = [];
    if (action.source_entity_id !== undefined) {
      details.push("source: " + labelForEntity(action.source_entity_id));
    }
    if (action.target_entity_id !== undefined) {
      details.push("target: " + labelForEntity(action.target_entity_id));
    }
    if (action.choose_option_entity_id !== undefined) {
      details.push("branch: " + labelForEntity(action.choose_option_entity_id));
    }
    if (action.position !== undefined) {
      details.push("position: " + String(action.position));
    }
    if (action.choice_entity_id !== undefined) {
      details.push("choice: " + labelForEntity(action.choice_entity_id));
    }
    if (action.mulligan_entity_ids !== undefined) {
      details.push("cards: " + String(asArray(action.mulligan_entity_ids).length));
    }
    return details.join(" • ");
  }

  function renderOutcome(outcome, phase) {
    if (!isObject(outcome) || phase !== "GAME_OVER") {
      return;
    }
    const winner = outcome.winner === null || outcome.winner === undefined
      ? "Tie"
      : String(outcome.winner);
    showNotice("Game over — winner: " + winner, "outcome", 0);
  }

  function setButtonsDisabled(disabled) {
    asArray(elements["action-menu"].querySelectorAll("button")).forEach(function (button) {
      button.disabled = disabled;
    });
  }

  function submitAction(index) {
    if (busy || !snapshot) {
      return;
    }
    const actions = asArray(snapshot.legal_actions);
    const action = actions[index];
    if (!isObject(action)) {
      showNotice("That action is no longer available. Reloading the current state…", "error", 0);
      loadState();
      return;
    }

    busy = true;
    setButtonsDisabled(true);
    setConnection("Submitting…", false);
    fetch(API_ACTION, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ revision: snapshot.revision, action: action }),
    })
      .then(readJsonResponse)
      .then(function (payload) {
        const next = snapshotFromPayload(payload);
        if (!next) {
          throw new Error("The action response is missing a game snapshot.");
        }
        applySnapshot(next);
        setConnection("Connected", false);
        if (!(isObject(next.outcome) || (isObject(next.observation) && next.observation.phase === "GAME_OVER"))) {
          showNotice("Action accepted.", "", 2200);
        }
      })
      .catch(function (error) {
        const next = error && error.payload ? snapshotFromPayload(error.payload) : null;
        if (next) {
          applySnapshot(next);
        }
        if (error && error.status === 409) {
          showNotice("That action was stale. The current game state has been loaded; choose again.", "error", 0);
        } else {
          showNotice("Action failed: " + errorMessage(error), "error", 0);
        }
        setConnection(error && error.status ? "Server rejected action" : "Disconnected", true);
      })
      .finally(function () {
        busy = false;
        setButtonsDisabled(false);
      });
  }

  window.addEventListener("DOMContentLoaded", init);
  window.fireplaceWebGui = {
    loadState: loadState,
    submitAction: submitAction,
  };
}());
