(function () {
  "use strict";

  var API_STATE = "/api/state";
  var API_ACTION = "/api/action";
  var Model = window.FireplaceActionModel;
  var elements = {};
  var guiState = createGuiState(Model);
  var busy = false;
  var noticeTimer = null;
  var pollTimer = null;
  var assetRequests = new Map();
  var attackPointer = null;
  var attackLine = null;
  var attackStroke = null;

  window.addEventListener("beforeunload", function () {
    assetRequests.forEach(function (entry) {
      if (entry.objectUrl) {
        URL.revokeObjectURL(entry.objectUrl);
      }
    });
  });

  var TYPE_LABELS = {
    MULLIGAN: "换牌",
    CHOOSE: "选择",
    PLAY_CARD: "出牌",
    ATTACK: "攻击",
    USE_HERO_POWER: "英雄技能",
    END_TURN: "结束回合",
  };

  function emptySelection() {
    return {
      type: null,
      sourceId: null,
      branchId: null,
      targetId: null,
      position: null,
      mulliganIds: [],
    };
  }

  /*
   * Snapshot and selection state stays independent from the DOM renderer.  The
   * store only normalizes the server boundary, indexes the original legal
   * Action objects, and reconciles an in-progress selection when a newer
   * snapshot arrives.  Rendering and network feedback consume the transition
   * returned by commit() without changing Action construction.
   */
  function createGuiState(model) {
    var current = {
      snapshot: null,
      actionIndex: model.index([]),
      selection: emptySelection(),
      fingerprint: "",
      latestEventSeq: null,
      outcomeDismissedRevision: null,
    };

    function isDecisionChanged(next) {
      return !current.snapshot ||
        next.session_id !== current.snapshot.session_id ||
        next.revision !== current.snapshot.revision;
    }

    function isStale(next) {
      return Boolean(current.snapshot &&
        next.session_id === current.snapshot.session_id &&
        next.revision < current.snapshot.revision);
    }

    function selectionCriteria(value) {
      var criteria = {};
      if (value.type) {
        criteria.type = value.type;
      }
      if (value.sourceId !== null) {
        criteria.source_entity_id = value.sourceId;
      }
      if (value.branchId !== null) {
        criteria.choose_option_entity_id = value.branchId;
      }
      if (value.targetId !== null) {
        criteria.target_entity_id = value.targetId;
      }
      if (value.position !== null) {
        criteria.position = value.position;
      }
      return criteria;
    }

    function hasSelection(value) {
      return Boolean(value.type) || value.sourceId !== null ||
        value.branchId !== null || value.targetId !== null ||
        value.position !== null || value.mulliganIds.length > 0;
    }

    function selectionIsValid(value, indexed) {
      if (!hasSelection(value)) {
        return true;
      }
      if (value.type === "MULLIGAN" || value.mulliganIds.length) {
        return Boolean(model.findMulligan(indexed, value.mulliganIds));
      }
      return model.filter(indexed.actions, selectionCriteria(value)).length > 0;
    }

    function cloneSelection(value) {
      var next = value || emptySelection();
      return {
        type: next.type || null,
        sourceId: next.sourceId === undefined ? null : next.sourceId,
        branchId: next.branchId === undefined ? null : next.branchId,
        targetId: next.targetId === undefined ? null : next.targetId,
        position: next.position === undefined ? null : next.position,
        mulliganIds: asArray(next.mulliganIds).slice(),
      };
    }

    return {
      current: current,
      isDecisionChanged: isDecisionChanged,
      isStale: isStale,
      selectedActions: function () {
        return model.filter(current.actionIndex.actions, selectionCriteria(current.selection));
      },
      resetSelection: function () {
        current.selection = emptySelection();
        return current.selection;
      },
      commit: function (next, options) {
        var previous = current.snapshot;
        var previousEventSeq = current.latestEventSeq;
        var sessionChanged = Boolean(previous && previous.session_id !== next.session_id);
        var resetSelection = Boolean(options && options.resetSelection) || sessionChanged || isDecisionChanged(next);
        var indexed = model.index(next.legal_actions);
        if (resetSelection || !selectionIsValid(current.selection, indexed)) {
          current.selection = emptySelection();
          resetSelection = true;
        } else {
          current.selection = cloneSelection(current.selection);
        }
        current.snapshot = next;
        current.actionIndex = indexed;
        current.fingerprint = snapshotFingerprint(next);
        var events = asArray(next.events);
        var newest = events.length ? events[events.length - 1] : null;
        var newestSeq = safeNumber(newest && newest.seq, previousEventSeq);
        if (sessionChanged) {
          current.latestEventSeq = null;
          current.outcomeDismissedRevision = null;
          previousEventSeq = null;
        }
        if (events.length) {
          current.latestEventSeq = newestSeq;
        }
        return {
          previous: previous,
          previousEventSeq: previousEventSeq,
          newest: newest,
          newestSeq: newestSeq,
          events: events,
          resetSelection: resetSelection,
          sessionChanged: sessionChanged,
        };
      },
    };
  }

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
      "opponent-extras",
      "opponent-board-count",
      "opponent-board",
      "self-hero-row",
      "self-extras",
      "self-board-count",
      "self-board",
      "hero-power-row",
      "mana-value",
      "hand",
      "deck-count",
      "action-count",
      "decision-panel",
      "action-instructions",
      "selection-summary",
      "quick-actions",
      "choice-options",
      "position-choices",
      "target-hint",
      "action-submit",
      "selection-cancel",
      "end-turn-button",
      "pending-choice",
      "action-menu",
      "fallback-count",
      "event-log",
      "game-over",
      "game-over-message",
      "game-over-dismiss",
      "connection-value",
      "card-modal",
      "modal-close",
      "modal-art",
      "modal-card-name",
      "modal-card-id",
      "modal-stats",
      "modal-card-text",
    ].forEach(function (id) {
      elements[id] = getElement(id);
    });

    initAttackLine();

    elements["action-submit"].addEventListener("click", submitSelected);
    elements["selection-cancel"].addEventListener("click", cancelSelection);
    elements["end-turn-button"].addEventListener("click", submitEndTurn);
    elements["modal-close"].addEventListener("click", closeCardModal);
    elements["game-over-dismiss"].addEventListener("click", function () {
      guiState.current.outcomeDismissedRevision = guiState.current.snapshot ? guiState.current.snapshot.revision : null;
      setHidden(elements["game-over"], true);
    });
    elements["card-modal"].addEventListener("click", function (event) {
      if (event.target && event.target.getAttribute("data-modal-close") === "true") {
        closeCardModal();
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (!elements["card-modal"].hidden) {
          closeCardModal();
        } else if (guiState.current.selection.type || guiState.current.selection.sourceId !== null) {
          cancelSelection();
        }
      }
    });

    loadState(false);
    pollTimer = window.setInterval(function () {
      if (!busy) {
        pollState();
      }
    }, 2500);
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
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

  function entityId(value) {
    return Model.id(value);
  }

  function cardName(card) {
    if (!isObject(card)) {
      return "未知卡牌";
    }
    return safeText(card.name, safeText(card.card_id, "未知卡牌"));
  }

  function cardText(card) {
    if (!isObject(card) || card.text === undefined || card.text === null) {
      return "";
    }
    var text = String(card.text);
    if (!text || text === String(card.card_id || "")) {
      return "";
    }
    return text
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/\$([0-9]+)/g, "$1");
  }

  function labelForType(type) {
    return TYPE_LABELS[type] || safeText(type, "动作");
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
      elements["connection-value"].classList.toggle("connection-error", Boolean(isError));
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
    return "未知错误";
  }

  function readJsonResponse(response) {
    return response.text().then(function (body) {
      var payload = {};
      if (body) {
        try {
          payload = JSON.parse(body);
        } catch (error) {
          throw new Error("服务器返回了无效 JSON（HTTP " + response.status + "）。");
        }
      }
      if (!response.ok) {
        var failure = new Error(errorMessage(payload.error) || ("HTTP " + response.status));
        failure.payload = payload;
        failure.status = response.status;
        throw failure;
      }
      return payload;
    });
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
      session_id: safeText(payload.session_id, ""),
      revision: safeNumber(payload.revision, 0),
      observation: payload.observation,
      legal_actions: payload.legal_actions,
      outcome: payload.outcome === undefined ? null : payload.outcome,
      events: Array.isArray(payload.events) ? payload.events : [],
    };
  }

  function snapshotFingerprint(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(Date.now());
    }
  }

  function loadState(silent) {
    if (!silent) {
      setConnection("读取对局……", false);
    }
    return fetch(API_STATE, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(readJsonResponse)
      .then(function (payload) {
        var next = snapshotFromPayload(payload);
        if (!next) {
          throw new Error("状态响应缺少对局快照。");
        }
        if (guiState.isStale(next)) {
          return guiState.current.snapshot;
        }
        applySnapshot(next, { resetSelection: guiState.isDecisionChanged(next) });
        setConnection("已连接", false);
        return next;
      })
      .catch(function (error) {
        setConnection("连接断开", true);
        if (!silent || !guiState.current.snapshot) {
          showNotice("无法读取本机对局：" + errorMessage(error), "error", 0);
          if (!guiState.current.snapshot) {
            renderEmptyState();
          }
        }
        return null;
      });
  }

  function pollState() {
    fetch(API_STATE, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(readJsonResponse)
      .then(function (payload) {
        var next = snapshotFromPayload(payload);
        if (!next) {
          return;
        }
        if (guiState.isStale(next)) {
          return;
        }
        setConnection("已连接", false);
        var fingerprint = snapshotFingerprint(next);
        if (fingerprint !== guiState.current.fingerprint) {
          var hadSnapshot = Boolean(guiState.current.snapshot);
          var decisionChanged = guiState.isDecisionChanged(next);
          applySnapshot(next, { resetSelection: decisionChanged });
          if (decisionChanged && hadSnapshot && !busy) {
            showNotice("对局状态已更新，请重新选择当前合法操作。", "", 3200);
          }
        }
      })
      .catch(function () {
        setConnection("连接断开", true);
      });
  }

  function applySnapshot(next, options) {
    var transition = guiState.commit(next, options);
    var previous = transition.previous;
    var previousEventSeq = transition.previousEventSeq;
    if (transition.sessionChanged) {
      previous = null;
      assetRequests.forEach(function (entry) {
        entry.cancelled = true;
        if (entry.objectUrl) {
          URL.revokeObjectURL(entry.objectUrl);
        }
      });
      assetRequests.clear();
    }
    var resetSelection = transition.resetSelection;
    var focusId = null;
    var focusEntityId = null;
    var focusInspectEntityId = null;
    var focusPosition = null;
    var focusActionKey = null;
    if (!resetSelection && document.activeElement) {
      var active = document.activeElement;
      focusId = active.id || null;
      focusEntityId = active.getAttribute && active.getAttribute("data-entity-id");
      if (active.classList && active.classList.contains("card-inspect")) {
        var card = active.closest("[data-entity-id]");
        focusInspectEntityId = card && card.getAttribute("data-entity-id");
      }
      focusPosition = active.getAttribute && active.getAttribute("data-position");
      focusActionKey = active.getAttribute && active.getAttribute("data-action-key");
    }
    var events = transition.events;
    var newest = transition.newest;
    var newestSeq = transition.newestSeq;
    renderSnapshot();
    showPublicFeedback(previous, next, previousEventSeq);
    if (!resetSelection) {
      var focusNode = focusId ? document.getElementById(focusId) : null;
      if (!focusNode && focusEntityId) {
        focusNode = document.querySelector('[data-entity-id="' + focusEntityId + '"]');
      }
      if (!focusNode && focusInspectEntityId) {
        focusNode = document.querySelector('[data-entity-id="' + focusInspectEntityId + '"] .card-inspect');
      }
      if (!focusNode && focusPosition !== null) {
        focusNode = Array.from(document.querySelectorAll("[data-position]"))
          .find(function (node) { return node.getAttribute("data-position") === focusPosition; });
      }
      if (!focusNode && focusActionKey) {
        focusNode = Array.from(document.querySelectorAll("[data-action-key]"))
          .find(function (node) { return node.getAttribute("data-action-key") === focusActionKey; });
      }
      if (focusNode && typeof focusNode.focus === "function") {
        focusNode.focus();
      }
    }

    if (previous && events.length) {
      var previousSeq = previousEventSeq === null ? -1 : previousEventSeq;
      if (newestSeq > previousSeq) {
        showNotice(eventText(newest), newest && newest.actor === "opponent" ? "ai-event" : "", 2600);
      }
    }
  }

  function publicCharacters(observation) {
    var characters = new Map();
    if (!isObject(observation)) {
      return characters;
    }
    [observation.self, observation.opponent].forEach(function (player) {
      if (!isObject(player)) {
        return;
      }
      [player.hero].concat(asArray(player.board)).forEach(function (card) {
        var id = entityId(card && card.entity_id);
        if (id !== null) {
          characters.set(id, card);
        }
      });
    });
    return characters;
  }

  function publicNode(entityIdValue) {
    var id = entityId(entityIdValue);
    if (id === null) {
      return null;
    }
    var selector = '[data-entity-id="' + String(id) + '"]';
    return ["self-hero-row", "opponent-hero-row", "self-board", "opponent-board"]
      .map(getElement)
      .map(function (container) { return container && container.querySelector(selector); })
      .find(function (node) { return Boolean(node); }) || null;
  }

  function initAttackLine() {
    var table = document.querySelector(".table");
    if (!table) {
      return;
    }
    attackLine = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    attackLine.classList.add("attack-line");
    attackLine.setAttribute("aria-hidden", "true");
    attackLine.hidden = true;
    attackStroke = document.createElementNS("http://www.w3.org/2000/svg", "line");
    attackLine.appendChild(attackStroke);
    table.appendChild(attackLine);
    table.addEventListener("pointermove", function (event) {
      var target = event.target instanceof Element ? event.target.closest(".targetable") : null;
      attackPointer = {
        clientX: event.clientX,
        clientY: event.clientY,
        target: target,
      };
      updateAttackLine();
    });
    table.addEventListener("pointerleave", function () {
      attackPointer = null;
      updateAttackLine();
    });
    window.addEventListener("resize", updateAttackLine);
  }

  function updateAttackLine() {
    if (!attackLine || !attackStroke) {
      return;
    }
    var selection = guiState.current.selection;
    var source = selection.type === "ATTACK" && publicNode(selection.sourceId);
    var table = document.querySelector(".table");
    if (!source || !table || !attackPointer || !table.contains(source)) {
      attackLine.hidden = true;
      return;
    }
    var tableRect = table.getBoundingClientRect();
    var sourceRect = source.getBoundingClientRect();
    var target = attackPointer.target;
    var targetId = target && entityId(target.getAttribute("data-entity-id"));
    if (!target || !target.isConnected || !targetIds().has(targetId)) {
      target = null;
    }
    var targetRect = target && target.getBoundingClientRect();
    var x1 = sourceRect.left + sourceRect.width / 2 - tableRect.left;
    var y1 = sourceRect.top + sourceRect.height / 2 - tableRect.top;
    var x2 = targetRect
      ? targetRect.left + targetRect.width / 2 - tableRect.left
      : attackPointer.clientX - tableRect.left;
    var y2 = targetRect
      ? targetRect.top + targetRect.height / 2 - tableRect.top
      : attackPointer.clientY - tableRect.top;
    attackLine.setAttribute("viewBox", "0 0 " + String(tableRect.width) + " " + String(tableRect.height));
    attackStroke.setAttribute("x1", String(x1));
    attackStroke.setAttribute("y1", String(y1));
    attackStroke.setAttribute("x2", String(x2));
    attackStroke.setAttribute("y2", String(y2));
    attackLine.classList.toggle("snapped", Boolean(target));
    attackLine.hidden = false;
  }

  function transientClass(node, className) {
    if (!node) {
      return;
    }
    node.classList.add(className);
    window.setTimeout(function () {
      if (node.isConnected) {
        node.classList.remove(className);
      }
    }, 850);
  }

  function showPublicFeedback(previous, next, previousEventSeq) {
    if (!previous || previous.revision === next.revision) {
      return;
    }
    var oldCharacters = publicCharacters(previous.observation);
    publicCharacters(next.observation).forEach(function (card, id) {
      var before = oldCharacters.get(id);
      var node = publicNode(id);
      if (!before) {
        transientClass(node, "summon-flash");
      } else if (safeNumber(card.health, 0) < safeNumber(before.health, 0) ||
          safeNumber(card.armor, 0) < safeNumber(before.armor, 0)) {
        transientClass(node, "damage-flash");
      } else if (safeNumber(card.health, 0) > safeNumber(before.health, 0) ||
          safeNumber(card.armor, 0) > safeNumber(before.armor, 0)) {
        transientClass(node, "heal-flash");
      }
    });
    asArray(next.events).forEach(function (event) {
      if (event.type === "ATTACK" && safeNumber(event.seq, -1) > safeNumber(previousEventSeq, -1)) {
        transientClass(publicNode(event.source_entity_id), "attack-source");
        transientClass(publicNode(event.target_entity_id), "attack-target");
      }
    });
  }

  function renderEmptyState() {
    setText(elements["phase-value"], "不可用");
    setText(elements["turn-value"], "回合 —");
    setText(elements["active-seat-value"], "行动方 —");
    setText(elements["revision-value"], "版本 —");
    clear(elements["hand"]);
    clear(elements["self-board"]);
    clear(elements["opponent-board"]);
    clear(elements["self-hero-row"]);
    elements["self-hero-row"].closest(".self-panel").classList.remove("promote-interaction");
    clear(elements["opponent-hero-row"]);
    clear(elements["self-extras"]);
    clear(elements["opponent-extras"]);
    setHidden(elements["self-extras"], true);
    setHidden(elements["opponent-extras"], true);
    clear(elements["hero-power-row"]);
    clear(elements["event-log"]);
    renderDecision();
    updateAttackLine();
  }

  function renderSnapshot() {
    var snapshot = guiState.current.snapshot;
    var actionIndex = guiState.current.actionIndex;
    var observation = isObject(snapshot.observation) ? snapshot.observation : {};
    var self = isObject(observation.self) ? observation.self : {};
    var opponent = isObject(observation.opponent) ? observation.opponent : {};
    var phase = safeText(observation.phase, "UNKNOWN").toUpperCase();

    setText(elements["phase-value"], phaseLabel(phase));
    setText(elements["turn-value"], observation.turn === null || observation.turn === undefined ? "回合 —" : "回合 " + String(observation.turn));
    setText(elements["active-seat-value"], observation.active_seat === null || observation.active_seat === undefined ? "行动方 —" : "行动方 " + String(observation.active_seat) + (observation.active_seat === 0 ? "（你）" : "（对手）"));
    setText(elements["revision-value"], "版本 " + String(snapshot.revision));
    setText(elements["mana-value"], manaText(self));
    setText(elements["opponent-mana-value"], manaText(opponent));
    setText(elements["opponent-hand-count"], String(safeNumber(opponent.hand_count, 0)) + " 张手牌");
    setText(elements["deck-count"], "牌库 " + String(safeNumber(self.deck_count, 0)));
    setText(elements["self-board-count"], boardCountText(self.board));
    setText(elements["opponent-board-count"], boardCountText(opponent.board));
    setText(elements["action-count"], String(actionIndex.actions.length) + " 个合法动作");
    setText(elements["fallback-count"], "（" + String(actionIndex.actions.length) + "）");

    renderHiddenHand(opponent.hand_count);
    renderHero(elements["opponent-hero-row"], opponent.hero, false, opponent.hero_power);
    renderHero(elements["self-hero-row"], self.hero, true, self.hero_power);
    renderExtras(elements["opponent-extras"], opponent, false);
    renderExtras(elements["self-extras"], self, true);
    renderBoard(elements["opponent-board"], opponent.board, false);
    renderBoard(elements["self-board"], self.board, true);
    renderHeroPower(self.hero_power);
    renderHand(self.hand, phase);
    renderDecision();
    renderActions();
    renderLog(snapshot.events);
    renderOutcome(snapshot.outcome, phase);
    updateAttackLine();
  }

  function phaseLabel(phase) {
    return {
      MULLIGAN: "换牌",
      CHOICE: "选择",
      MAIN: "主阶段",
      GAME_OVER: "对局结束",
    }[phase] || phase;
  }

  function manaText(player) {
    var mana = player && player.mana !== undefined ? player.mana : "—";
    var maxMana = player && player.max_mana !== undefined ? player.max_mana : "—";
    return String(mana) + " / " + String(maxMana) + " 法力";
  }

  function boardCountText(board) {
    var count = asArray(board).length;
    return count + " 个随从";
  }

  function renderHiddenHand(count) {
    clear(elements["opponent-hand"]);
    var amount = Math.max(0, safeNumber(count, 0));
    for (var index = 0; index < amount; index += 1) {
      var card = document.createElement("span");
      card.className = "hidden-card";
      card.setAttribute("aria-label", "对手暗手牌 " + String(index + 1));
      card.setAttribute("data-testid", "hidden-opponent-card");
      elements["opponent-hand"].appendChild(card);
    }
  }

  function entityLabels() {
    var labels = new Map();
    var snapshot = guiState.current.snapshot;
    if (!snapshot || !isObject(snapshot.observation)) {
      return labels;
    }
    var observation = snapshot.observation;
    var self = isObject(observation.self) ? observation.self : {};
    var opponent = isObject(observation.opponent) ? observation.opponent : {};
    addEntityLabel(labels, self.hero, "你的英雄：" + cardName(self.hero));
    addEntityLabel(labels, self.hero_power, "你的技能：" + cardName(self.hero_power));
    addEntityLabel(labels, opponent.hero, "对手英雄：" + cardName(opponent.hero));
    addEntityLabel(labels, opponent.hero_power, "对手技能：" + cardName(opponent.hero_power));
    asArray(self.hand).forEach(function (card) { addEntityLabel(labels, card, cardName(card)); });
    asArray(self.board).forEach(function (card) { addEntityLabel(labels, card, cardName(card)); });
    asArray(opponent.board).forEach(function (card) { addEntityLabel(labels, card, "对手：" + cardName(card)); });
    var pending = isObject(observation.pending_choice) ? observation.pending_choice : {};
    asArray(pending.options).forEach(function (card) { addEntityLabel(labels, card, cardName(card)); });
    asArray(self.hand).forEach(function (card) {
      asArray(card && card.choose_options).forEach(function (option) { addEntityLabel(labels, option, cardName(option)); });
    });
    return labels;
  }

  function addEntityLabel(labels, entity, label) {
    if (!isObject(entity)) {
      return;
    }
    var id = entityId(entity.entity_id);
    if (id !== null) {
      labels.set(id, label || cardName(entity));
    }
  }

  function labelForEntity(entityIdValue) {
    var id = entityId(entityIdValue);
    if (id === null) {
      return "目标";
    }
    return entityLabels().get(id) || "实体 #" + String(id);
  }

  function renderHero(container, hero, own, power) {
    clear(container);
    container.classList.remove("promote-interaction");
    if (own) {
      container.closest(".self-panel").classList.remove("promote-interaction");
    }
    if (!isObject(hero)) {
      var empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "没有英雄信息";
      container.appendChild(empty);
      return;
    }
    var id = entityId(hero.entity_id);
    var target = targetIds().has(id);
    var sourceTypes = sourceTypesFor(id);
    container.classList.toggle("promote-interaction", own && (target || sourceTypes.length > 0));
    if (own && (target || sourceTypes.length > 0)) {
      container.closest(".self-panel").classList.add("promote-interaction");
    }
    var wrapper = createEntityCard(hero, "hero-card " + (target ? "targetable " : "") + (sourceTypes.length ? "sourceable" : ""), function () {
      if (target && chooseTarget(id)) {
        return;
      }
      if (sourceTypes.length) {
        chooseSource(sourceTypes[0], id);
      }
    });
    wrapper.classList.add(own ? "own-hero" : "enemy-hero");
    var art = createCardArt(hero, "art");
    wrapper.appendChild(art);
    var copy = document.createElement("div");
    copy.className = "hero-copy";
    copy.appendChild(cardTitle(hero));
    var subtitle = document.createElement("p");
    subtitle.className = "card-subtitle";
    subtitle.textContent = own ? "你的英雄" : "对手英雄";
    copy.appendChild(subtitle);
    if (!own && isObject(power)) {
      var powerSummary = document.createElement("p");
      powerSummary.className = "card-subtitle public-power";
      powerSummary.textContent = "技能：" + cardName(power) +
        (power.cost === undefined || power.cost === null ? "" : " · 费用 " + String(power.cost));
      copy.appendChild(powerSummary);
    }
    copy.appendChild(createCharacterStats(hero, safeNumber(hero.atk, 0) > 0));
    wrapper.appendChild(copy);
    container.appendChild(wrapper);
  }

  function renderExtras(container, player, own) {
    clear(container);
    var weapon = isObject(player.weapon) ? player.weapon : null;
    if (weapon) {
      var weaponButton = document.createElement("button");
      weaponButton.type = "button";
      weaponButton.className = "extra-chip weapon-chip";
      weaponButton.setAttribute("data-testid", own ? "self-weapon" : "opponent-weapon");
      weaponButton.appendChild(createCardArt(weapon, "tile"));
      var weaponText = document.createElement("span");
      weaponText.textContent = "武器：" + cardName(weapon) + " · " +
        String(safeNumber(weapon.atk, 0)) + " 攻 / " +
        String(safeNumber(weapon.durability, 0)) + " 耐久";
      weaponButton.appendChild(weaponText);
      weaponButton.addEventListener("click", function () { openCardModal(weapon); });
      container.appendChild(weaponButton);
    }
    if (own) {
      asArray(player.secrets).forEach(function (secret) {
        var secretButton = document.createElement("button");
        secretButton.type = "button";
        secretButton.className = "extra-chip secret-chip";
        secretButton.setAttribute("data-testid", "self-secret");
        secretButton.textContent = "奥秘：" + cardName(secret);
        secretButton.addEventListener("click", function () { openCardModal(secret); });
        container.appendChild(secretButton);
      });
    } else if (safeNumber(player.secrets_count, 0) > 0) {
      var hiddenSecrets = document.createElement("span");
      hiddenSecrets.className = "extra-chip secret-chip hidden-secret";
      hiddenSecrets.setAttribute("data-testid", "opponent-secret-count");
      hiddenSecrets.textContent = "对手奥秘 ×" + String(player.secrets_count);
      container.appendChild(hiddenSecrets);
    }
    setHidden(container, !container.childNodes.length);
  }

  function renderBoard(container, board, own) {
    clear(container);
    var cards = asArray(board);
    var selection = guiState.current.selection;
    var positions = own && selection.sourceId !== null && selection.type === "PLAY_CARD"
      ? Model.uniqueValues(selectedActions(), "position").slice().sort(function (left, right) { return left - right; })
      : [];
    cards.forEach(function (card, index) {
      if (positions.indexOf(index) >= 0) {
        container.appendChild(createPositionSlot(index));
      }
      var id = entityId(card && card.entity_id);
      var target = targetIds().has(id);
      var sourceTypes = own ? sourceTypesFor(id) : [];
      var wrapper = createEntityCard(card, "card board-card " + (target ? "targetable " : "") + (sourceTypes.length ? "sourceable" : ""), function () {
        if (target && chooseTarget(id)) {
          return;
        }
        if (sourceTypes.length) {
          chooseSource(sourceTypes[0], id);
        }
      });
      wrapper.setAttribute("data-entity-id", String(id === null ? "" : id));
      wrapper.appendChild(createCardArt(card, "art"));
      var content = document.createElement("div");
      content.className = "card-content";
      content.appendChild(cardTitle(card));
      content.appendChild(createCharacterStats(card, true, true));
      content.appendChild(createKeywordBadges(card, own));
      appendCardText(content, card);
      wrapper.appendChild(content);
      container.appendChild(wrapper);
    });
    if (positions.indexOf(cards.length) >= 0) {
      container.appendChild(createPositionSlot(cards.length));
    }
  }

  function createPositionSlot(position) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "board-slot";
    button.setAttribute("data-position", String(position));
    button.setAttribute("aria-label", "插入到" + positionLabel(position));
    button.textContent = "+";
    button.addEventListener("click", function () { choosePosition(position); });
    return button;
  }

  function renderHeroPower(power) {
    clear(elements["hero-power-row"]);
    if (!isObject(power)) {
      return;
    }
    var id = entityId(power.entity_id);
    var sourceTypes = sourceTypesFor(id);
    var wrapper = createEntityCard(power, "power-card " + (sourceTypes.length ? "sourceable" : ""), function () {
      if (sourceTypes.length) {
        chooseSource(sourceTypes[0], id);
      }
    });
    wrapper.appendChild(createCardArt(power, "art"));
    var copy = document.createElement("div");
    copy.className = "power-copy";
    copy.appendChild(cardTitle(power, "技能："));
    var details = document.createElement("p");
    details.className = "card-subtitle";
    details.textContent = (power.cost === undefined || power.cost === null ? "" : "费用 " + String(power.cost) + " · ") +
      (power.is_usable ? "可以使用" : (power.exhausted ? "本回合已使用" : "当前不可用"));
    copy.appendChild(details);
    appendCardText(copy, power);
    wrapper.appendChild(copy);
    elements["hero-power-row"].appendChild(wrapper);
  }

  function renderHand(hand, phase) {
    clear(elements["hand"]);
    var selection = guiState.current.selection;
    asArray(hand).forEach(function (card) {
      var id = entityId(card && card.entity_id);
      var sourceTypes = phase === "MAIN" ? sourceTypesFor(id) : [];
      var mulliganSelected = selection.mulliganIds.some(function (value) { return value === id; });
      var wrapper = createEntityCard(card, "card hand-card " + (sourceTypes.length ? "sourceable" : "") + (mulliganSelected ? " mulligan-selected" : ""), function () {
        if (phase === "MULLIGAN") {
          toggleMulligan(id);
        } else if (sourceTypes.length) {
          chooseSource(sourceTypes[0], id);
        }
      });
      wrapper.setAttribute("data-entity-id", String(id === null ? "" : id));
      wrapper.setAttribute("data-testid", "hand-card");
      wrapper.appendChild(createCardArt(card, "render"));
      var cost = document.createElement("span");
      cost.className = "card-cost";
      cost.textContent = card && card.cost !== undefined && card.cost !== null ? String(card.cost) : "—";
      wrapper.appendChild(cost);
      var content = document.createElement("div");
      content.className = "card-content";
      content.appendChild(cardTitle(card));
      if (asArray(card && card.choose_options).length) {
        content.appendChild(createBadge("选择一项", "branch-badge"));
      }
      appendCardText(content, card);
      wrapper.appendChild(content);
      elements["hand"].appendChild(wrapper);
    });
  }

  function createEntityCard(card, className, onSelect) {
    var wrapper = document.createElement("article");
    wrapper.className = className + " card-zoomable";
    wrapper.setAttribute("aria-label", cardName(card));
    wrapper.title = "点击操作；右上角查看卡牌详情";
    var visibleId = entityId(card && card.entity_id);
    if (visibleId !== null) {
      wrapper.setAttribute("data-entity-id", String(visibleId));
    }
    if (typeof onSelect === "function") {
      wrapper.setAttribute("role", "button");
      wrapper.tabIndex = 0;
      wrapper.addEventListener("click", function () {
        onSelect();
      });
      wrapper.addEventListener("keydown", function (event) {
        if (event.target === wrapper && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect();
        }
      });
    }
    var inspect = document.createElement("button");
    inspect.type = "button";
    inspect.className = "card-inspect";
    inspect.textContent = "⌕";
    inspect.setAttribute("aria-label", "查看" + cardName(card) + "的详情");
    inspect.setAttribute("data-testid", "card-inspect");
    inspect.addEventListener("click", function (event) {
      event.stopPropagation();
      openCardModal(card);
    });
    wrapper.appendChild(inspect);
    return wrapper;
  }

  function createCardArt(card, kind) {
    var art = document.createElement("div");
    art.className = "card-art asset-placeholder";
    var cardId = isObject(card) ? card.card_id : null;
    if (cardId) {
      var image = document.createElement("img");
      image.alt = cardName(card) + " 卡图";
      image.loading = "lazy";
      image.hidden = true;
      var preferredKind = kind || "render";
      var imageRank = -1;
      image.addEventListener("load", function () {
        art.classList.remove("asset-placeholder");
      });
      image.addEventListener("error", function () {
        image.hidden = true;
        art.classList.add("asset-placeholder");
      });
      art.appendChild(image);
      function offerAsset(assetKind, result) {
        if (!result || !result.url || !image.isConnected) {
          return;
        }
        var rank = assetKind === preferredKind ? 2 : 1;
        if (rank > imageRank) {
          imageRank = rank;
          art.classList.remove("asset-kind-render", "asset-kind-art", "asset-kind-tile");
          art.classList.add("asset-kind-" + assetKind);
          image.src = result.url;
          image.hidden = false;
        }
      }
      function loadKind(assetKind, remainingRetries) {
        requestAsset(assetKind, String(cardId)).then(function (result) {
          if (result && result.url) {
            offerAsset(assetKind, result);
          } else if (remainingRetries > 0 && art.isConnected) {
            // A transient 404 or offline placeholder should not make this
            // visible card permanently blank for the rest of the match.
            window.setTimeout(function () {
              if (art.isConnected) {
                loadKind(assetKind, remainingRetries - 1);
              }
            }, 16000);
          }
        });
      }
      if (preferredKind !== "render") {
        // A cached full render gives an immediate offline fallback while the
        // cropped illustration is fetched.  Neither URL leaves this server.
        loadKind("render", 2);
      }
      loadKind(preferredKind, 2);
    }
    var mark = document.createElement("span");
    mark.className = "asset-mark";
    mark.textContent = cardId ? "✦" : "?";
    art.appendChild(mark);
    return art;
  }

  function delay(milliseconds) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, milliseconds);
    });
  }

  function requestAsset(kind, cardId) {
    var key = kind + "|" + cardId;
    var existing = assetRequests.get(key);
    if (existing && (!existing.expiresAt || Date.now() < existing.expiresAt)) {
      return existing.promise;
    }
    assetRequests.delete(key);
    var entry = { objectUrl: null, promise: null, cancelled: false, expiresAt: 0 };
    function retryLater() {
      entry.expiresAt = Date.now() + 15000;
      return null;
    }
    var assetUrl = "/assets/" + encodeURIComponent(kind) + "/" + encodeURIComponent(cardId);
    entry.promise = (async function () {
      var networkErrors = 0;
      for (;;) {
        if (entry.cancelled) {
          return null;
        }
        try {
          var response = await fetch(assetUrl, { cache: "no-store" });
          if (entry.cancelled) {
            return null;
          }
          if (response.status === 202) {
            // The local resolver is still downloading.  One shared poll per
            // card survives DOM redraws and does not occupy a connection.
            await delay(1300);
            continue;
          }
          if (!response.ok) {
            return retryLater();
          }
          if (response.headers.get("X-Asset-Placeholder") === "1") {
            return retryLater();
          }
          var blob = await response.blob();
          if (entry.cancelled) {
            return null;
          }
          if (!blob.size || !blob.type.startsWith("image/")) {
            return retryLater();
          }
          entry.objectUrl = URL.createObjectURL(blob);
          return { url: entry.objectUrl };
        } catch (error) {
          networkErrors += 1;
          if (networkErrors >= 10) {
            return retryLater();
          }
          await delay(2000);
        }
      }
    }());
    assetRequests.set(key, entry);
    return entry.promise;
  }

  function cardTitle(card, prefix) {
    var title = document.createElement("p");
    title.className = "card-name";
    title.textContent = safeText(prefix, "") + cardName(card);
    return title;
  }

  function appendCardText(container, card) {
    var text = cardText(card);
    if (!text) {
      return;
    }
    var node = document.createElement("p");
    node.className = "card-text";
    node.textContent = text;
    container.appendChild(node);
  }

  function createCharacterStats(character, includeAttack, compactHealth) {
    var stats = document.createElement("div");
    stats.className = "stats";
    if (includeAttack && character.atk !== undefined) {
      stats.appendChild(createStat("attack", "攻击", character.atk));
    }
    if (character.health !== undefined) {
      var health = !compactHealth && character.max_health !== undefined && character.max_health !== null
        ? String(character.health) + " / " + String(character.max_health)
        : character.health;
      var healthStat = createStat("health", "生命", health);
      if (compactHealth && character.max_health !== undefined && character.max_health !== null) {
        healthStat.setAttribute("aria-label", "生命 " + String(character.health) + " / " + String(character.max_health));
        healthStat.title = "生命 " + String(character.health) + " / " + String(character.max_health);
      }
      stats.appendChild(healthStat);
    }
    if (character.armor !== undefined && character.armor) {
      stats.appendChild(createStat("armor", "护甲", character.armor));
    }
    return stats;
  }

  function createStat(kind, label, value) {
    var stat = document.createElement("span");
    stat.className = "stat " + kind;
    var strong = document.createElement("strong");
    strong.textContent = safeText(value, "—");
    stat.appendChild(strong);
    var suffix = document.createElement("span");
    suffix.textContent = label;
    stat.appendChild(suffix);
    return stat;
  }

  function createKeywordBadges(card, own) {
    var badges = document.createElement("div");
    badges.className = "card-badges";
    if (card.taunt) {
      badges.appendChild(createBadge("嘲讽", "taunt"));
    }
    if (card.divine_shield) {
      badges.appendChild(createBadge("圣盾", "shield"));
    }
    if (card.frozen) {
      badges.appendChild(createBadge("冻结", "frozen"));
    }
    if (card.stealthed) {
      badges.appendChild(createBadge("潜行", "stealth"));
    }
    if (card.can_attack) {
      badges.appendChild(createBadge("可攻击", "ready"));
    }
    if (own && card.zone_position !== undefined) {
      badges.appendChild(createBadge("位置 " + String(card.zone_position), "position"));
    }
    return badges;
  }

  function createBadge(text, extraClass) {
    var badge = document.createElement("span");
    badge.className = "badge" + (extraClass ? " " + extraClass : "");
    badge.textContent = safeText(text, "");
    return badge;
  }

  function sourceTypesFor(sourceId) {
    if (sourceId === null) {
      return [];
    }
    var actionIndex = guiState.current.actionIndex;
    return ["PLAY_CARD", "ATTACK", "USE_HERO_POWER"].filter(function (type) {
      return Model.sourceActions(actionIndex, type, sourceId).length > 0;
    });
  }

  function targetIds() {
    var selection = guiState.current.selection;
    var ids = new Set();
    if (selection.sourceId === null) {
      return ids;
    }
    selectedActions().forEach(function (action) {
      var id = entityId(action.target_entity_id);
      if (id !== null) {
        ids.add(id);
      }
    });
    return ids;
  }

  function selectedActions() {
    return guiState.selectedActions();
  }

  function chooseSource(type, sourceId) {
    if (busy || !guiState.current.snapshot) {
      return;
    }
    var selection = guiState.resetSelection();
    selection.type = type;
    selection.sourceId = sourceId;
    renderSnapshot();
    maybeSubmitSingle();
  }

  function chooseBranch(branchId) {
    var selection = guiState.current.selection;
    selection.branchId = branchId;
    selection.targetId = null;
    selection.position = null;
    renderSnapshot();
    maybeSubmitSingle();
  }

  function chooseTarget(targetIdValue) {
    var selection = guiState.current.selection;
    var id = entityId(targetIdValue);
    if (id === null || !targetIds().has(id)) {
      return false;
    }
    selection.targetId = id;
    renderSnapshot();
    maybeSubmitSingle();
    return true;
  }

  function choosePosition(position) {
    if (!Model.uniqueValues(selectedActions(), "position").some(function (value) { return value === position; })) {
      return;
    }
    guiState.current.selection.position = position;
    renderSnapshot();
    maybeSubmitSingle();
  }

  function maybeSubmitSingle() {
    var candidates = selectedActions();
    if (candidates.length !== 1) {
      return;
    }
    var action = candidates[0];
    if (!actionRequiresSelection(action)) {
      submitRawAction(action);
    }
  }

  function actionRequiresSelection(action) {
    var selection = guiState.current.selection;
    return isObject(action) && (
      (action.choose_option_entity_id !== undefined && selection.branchId === null) ||
      (action.target_entity_id !== undefined && selection.targetId === null) ||
      (action.position !== undefined && selection.position === null)
    );
  }

  function toggleMulligan(id) {
    if (id === null || !guiState.current.snapshot) {
      return;
    }
    var selection = guiState.current.selection;
    var next = selection.mulliganIds.slice();
    var index = next.indexOf(id);
    if (index >= 0) {
      next.splice(index, 1);
    } else {
      next.push(id);
    }
    selection.mulliganIds = next;
    renderSnapshot();
  }

  function cancelSelection() {
    guiState.resetSelection();
    renderSnapshot();
  }

  function submitSelected() {
    var snapshot = guiState.current.snapshot;
    var actionIndex = guiState.current.actionIndex;
    var selection = guiState.current.selection;
    if (!snapshot || busy) {
      return;
    }
    if (snapshot.observation.phase === "MULLIGAN") {
      var mulligan = Model.findMulligan(actionIndex, selection.mulliganIds);
      if (mulligan) {
        submitRawAction(mulligan);
      } else {
        showNotice("这组换牌选择已经不在当前合法动作中。", "error", 3600);
      }
      return;
    }
    var candidates = selectedActions();
    if (candidates.length === 1 && !actionRequiresSelection(candidates[0])) {
      submitRawAction(candidates[0]);
    } else {
      showNotice("请先选择分支、目标或随从站位。", "error", 2800);
    }
  }

  function submitEndTurn() {
    var actionIndex = guiState.current.actionIndex;
    if (actionIndex.endTurn.length === 1) {
      submitRawAction(actionIndex.endTurn[0]);
    }
  }

  function actionIndexOf(action) {
    var actionIndex = guiState.current.actionIndex;
    var direct = actionIndex.actions.indexOf(action);
    if (direct >= 0) {
      return direct;
    }
    var key = Model.actionKey(action);
    for (var index = 0; index < actionIndex.actions.length; index += 1) {
      if (Model.actionKey(actionIndex.actions[index]) === key) {
        return index;
      }
    }
    return -1;
  }

  function submitRawAction(action) {
    var index = actionIndexOf(action);
    if (index < 0) {
      showNotice("这个动作已经不在当前合法动作中，请重新选择。", "error", 3600);
      loadState(false);
      return;
    }
    submitAction(index);
  }

  function submitAction(index) {
    var snapshot = guiState.current.snapshot;
    var actionIndex = guiState.current.actionIndex;
    if (busy || !snapshot) {
      return;
    }
    var action = actionIndex.actions[index];
    if (!isObject(action)) {
      showNotice("动作已经过期，请重新读取当前状态。", "error", 0);
      loadState(false);
      return;
    }
    busy = true;
    setButtonsDisabled(true);
    setConnection("提交中……", false);
    fetch(API_ACTION, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: snapshot.session_id, revision: snapshot.revision, action: action }),
    })
      .then(readJsonResponse)
      .then(function (payload) {
        var next = snapshotFromPayload(payload);
        if (!next) {
          throw new Error("动作响应缺少对局快照。");
        }
        if (!guiState.isStale(next)) {
          applySnapshot(next, { resetSelection: true });
        }
        setConnection("已连接", false);
      })
      .catch(function (error) {
        var next = error && error.payload ? snapshotFromPayload(error.payload) : null;
        if (next && !guiState.isStale(next)) {
          applySnapshot(next, { resetSelection: true });
        }
        if (error && error.status === 409) {
          showNotice("动作已过期。已加载最新状态，请重新选择。", "error", 0);
        } else {
          showNotice("动作提交失败：" + errorMessage(error), "error", 0);
        }
        if (error && error.status === 409 && next) {
          setConnection("已连接", false);
        } else {
          setConnection(error && error.status ? "服务端拒绝动作" : "连接断开", true);
        }
      })
      .finally(function () {
        busy = false;
        setButtonsDisabled(false);
      });
  }

  function setButtonsDisabled(disabled) {
    document.querySelectorAll("button").forEach(function (button) {
      button.disabled = Boolean(disabled);
    });
  }

  function renderDecision() {
    var snapshot = guiState.current.snapshot;
    var actionIndex = guiState.current.actionIndex;
    var selection = guiState.current.selection;
    clear(elements["quick-actions"]);
    setHidden(elements["quick-actions"], true);
    clear(elements["choice-options"]);
    clear(elements["position-choices"]);
    clear(elements["pending-choice"]);
    setHidden(elements["pending-choice"], true);
    setHidden(elements["selection-summary"], true);
    setHidden(elements["action-instructions"], false);
    setHidden(elements["target-hint"], true);
    setHidden(elements["action-submit"], true);
    setHidden(elements["selection-cancel"], true);
    setHidden(elements["end-turn-button"], true);
    var phase = snapshot && snapshot.observation ? safeText(snapshot.observation.phase, "") : "";
    elements["decision-panel"].classList.toggle("phase-choice", phase === "CHOICE");
    elements["decision-panel"].classList.toggle("phase-mulligan", phase === "MULLIGAN");
    if (!snapshot) {
      setText(elements["action-instructions"], "等待本机服务……");
      return;
    }
    if (phase === "GAME_OVER") {
      setText(elements["action-instructions"], "本局已经结束。");
      return;
    }
    if (phase === "MULLIGAN") {
      setText(elements["action-instructions"], "点击想要替换的手牌，再确认换牌。也可以一张都不换。");
      renderPendingChoice(snapshot.observation.pending_choice);
      var mulliganAction = Model.findMulligan(actionIndex, selection.mulliganIds);
      setText(elements["action-submit"], mulliganAction ? "确认换牌" : "选择换牌牌组");
      setHidden(elements["action-submit"], false);
      return;
    }
    if (phase === "CHOICE") {
      setText(elements["action-instructions"], "请选择一张卡牌继续对局。");
      renderPendingChoice(snapshot.observation.pending_choice);
      renderChoiceOptions(actionIndex.choices);
      return;
    }
    if (phase !== "MAIN") {
      setText(elements["action-instructions"], "等待对手完成操作……");
      return;
    }

    // Directly actionable cards and the lower backup controls make the
    // permanent help banner redundant on the battlefield.  Selection hints
    // below remain visible when the player actually needs a choice.
    setHidden(elements["action-instructions"], true);

    if (actionIndex.endTurn.length === 1) {
      setHidden(elements["end-turn-button"], false);
    }
    if (selection.sourceId === null) {
      renderQuickActions();
    }
    var candidates = selectedActions();
    if (selection.sourceId !== null) {
      setHidden(elements["selection-cancel"], false);
      setText(elements["selection-summary"], selectedSummary(candidates));
      setHidden(elements["selection-summary"], false);
      renderSourceOptions(candidates);
      var targetOptions = Model.uniqueValues(candidates, "target_entity_id");
      if (targetOptions.length) {
        setText(elements["target-hint"], "请选择高亮目标。");
        setHidden(elements["target-hint"], false);
      }
      if (candidates.length === 1 && !actionRequiresSelection(candidates[0])) {
        setText(elements["action-submit"], "确认" + labelForType(candidates[0].type));
        setHidden(elements["action-submit"], false);
      }
      if (!candidates.length) {
        setText(elements["action-instructions"], "这个选择已经不再合法，请取消后重新选择。");
      }
    } else {
      setText(elements["action-instructions"], "选择下方操作，或直接点击手牌、场面随从和英雄技能；需要目标时会高亮。");
    }
  }

  function renderQuickActions() {
    var actionIndex = guiState.current.actionIndex;
    var groups = [
      { type: "PLAY_CARD", title: "出牌" },
      { type: "ATTACK", title: "攻击" },
      { type: "USE_HERO_POWER", title: "英雄技能" },
    ];
    groups.forEach(function (group) {
      var actions = actionIndex.byType.get(group.type) || [];
      var seen = new Set();
      var sources = [];
      actions.forEach(function (action) {
        var id = entityId(action.source_entity_id);
        if (id !== null && !seen.has(id)) {
          seen.add(id);
          sources.push(id);
        }
      });
      if (!sources.length) {
        return;
      }
      var section = document.createElement("section");
      section.className = "quick-action-group";
      var heading = document.createElement("h3");
      heading.className = "tool-heading";
      heading.textContent = group.title;
      section.appendChild(heading);
      var buttons = document.createElement("div");
      buttons.className = "quick-action-list";
      sources.forEach(function (id) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "quick-action-button";
        button.setAttribute("data-testid", "quick-action");
        button.setAttribute("data-action-type", group.type);
        button.setAttribute("data-source-id", String(id));
        button.textContent = group.title + " · " + labelForEntity(id) + sourceLocation(id, group.type);
        button.addEventListener("click", function () { chooseSource(group.type, id); });
        buttons.appendChild(button);
      });
      section.appendChild(buttons);
      elements["quick-actions"].appendChild(section);
    });
    setHidden(elements["quick-actions"], !elements["quick-actions"].childElementCount);
  }

  function sourceLocation(id, type) {
    var snapshot = guiState.current.snapshot;
    var self = snapshot && snapshot.observation && snapshot.observation.self;
    if (!isObject(self)) {
      return "";
    }
    var zone = type === "PLAY_CARD" ? asArray(self.hand) : asArray(self.board);
    var position = zone.findIndex(function (card) { return entityId(card.entity_id) === id; });
    if (position >= 0) {
      return type === "PLAY_CARD" ? " · 手牌 " + String(position + 1) : " · 场上 " + String(position + 1);
    }
    return "";
  }

  function renderPendingChoice(choice) {
    if (!isObject(choice)) {
      setHidden(elements["pending-choice"], true);
      return;
    }
    var bounds = [];
    if (choice.min_count !== undefined) {
      bounds.push("至少 " + String(choice.min_count));
    }
    if (choice.max_count !== undefined) {
      bounds.push("最多 " + String(choice.max_count));
    }
    var text = document.createElement("span");
    text.textContent = "当前选择" + (bounds.length ? "（" + bounds.join("，") + "）" : "");
    elements["pending-choice"].appendChild(text);
    setHidden(elements["pending-choice"], false);
  }

  function renderChoiceOptions(actions) {
    asArray(actions).forEach(function (action) {
      var option = optionCard(findVisibleEntity(action.choice_entity_id), function () {
        submitRawAction(action);
      });
      if (!option) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "option-button";
        button.textContent = "选择 " + labelForEntity(action.choice_entity_id);
        button.addEventListener("click", function () { submitRawAction(action); });
        elements["choice-options"].appendChild(button);
      } else {
        elements["choice-options"].appendChild(option);
      }
    });
  }

  function renderSourceOptions(candidates) {
    var selection = guiState.current.selection;
    var branches = Model.uniqueValues(candidates, "choose_option_entity_id");
    var positions = Model.uniqueValues(candidates, "position");
    if (branches.length) {
      var heading = document.createElement("p");
      heading.className = "tool-heading";
      heading.textContent = "选择分支";
      elements["choice-options"].appendChild(heading);
      branches.forEach(function (branchId) {
        var card = optionCard(findVisibleEntity(branchId), function () { chooseBranch(branchId); });
        if (card) {
          elements["choice-options"].appendChild(card);
        } else {
          var button = document.createElement("button");
          button.type = "button";
          button.className = "option-button" + (selection.branchId === branchId ? " selected" : "");
          button.textContent = labelForEntity(branchId);
          button.addEventListener("click", function () { chooseBranch(branchId); });
          elements["choice-options"].appendChild(button);
        }
      });
    }
    if (positions.length && selection.position === null) {
      var positionHeading = document.createElement("p");
      positionHeading.className = "tool-heading";
      positionHeading.textContent = "选择随从站位";
      elements["position-choices"].appendChild(positionHeading);
      positions.slice().sort(function (left, right) { return left - right; }).forEach(function (position) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "position-button";
        button.textContent = positionLabel(position);
        button.setAttribute("data-position", String(position));
        button.addEventListener("click", function () { choosePosition(position); });
        elements["position-choices"].appendChild(button);
      });
    }
  }

  function optionCard(card, onSelect) {
    if (!isObject(card)) {
      return null;
    }
    var wrapper = createEntityCard(card, "card option-card", onSelect);
    wrapper.appendChild(createCardArt(card, "render"));
    var copy = document.createElement("div");
    copy.className = "card-content";
    copy.appendChild(cardTitle(card));
    appendCardText(copy, card);
    wrapper.appendChild(copy);
    return wrapper;
  }

  function selectedSummary(candidates) {
    var selection = guiState.current.selection;
    var parts = [labelForType(selection.type) + " · " + labelForEntity(selection.sourceId)];
    if (selection.branchId !== null) {
      parts.push("分支：" + labelForEntity(selection.branchId));
    }
    if (selection.targetId !== null) {
      parts.push("目标：" + labelForEntity(selection.targetId));
    }
    if (selection.position !== null) {
      parts.push("位置：" + positionLabel(selection.position));
    }
    if (candidates.length > 1) {
      parts.push("还需选择");
    }
    return parts.join("　");
  }

  function positionLabel(position) {
    var value = Number(position);
    if (value === 0) {
      return "最左";
    }
    return "第 " + String(value + 1) + " 个位置";
  }

  function findVisibleEntity(id) {
    var snapshot = guiState.current.snapshot;
    var wanted = entityId(id);
    if (wanted === null || !snapshot) {
      return null;
    }
    var found = null;
    function visit(value) {
      if (found) {
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!isObject(value)) {
        return;
      }
      if (entityId(value.entity_id) === wanted && value.card_id) {
        found = value;
        return;
      }
      Object.keys(value).forEach(function (key) {
        if (!found && (Array.isArray(value[key]) || isObject(value[key]))) {
          visit(value[key]);
        }
      });
    }
    visit(snapshot.observation.self);
    visit(snapshot.observation.opponent);
    visit(snapshot.observation.pending_choice);
    return found;
  }

  function renderActions() {
    var snapshot = guiState.current.snapshot;
    var actionIndex = guiState.current.actionIndex;
    clear(elements["action-menu"]);
    var types = Model.actionTypes(actionIndex);
    if (!types.length) {
      var empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = snapshot && snapshot.outcome ? "对局已经结束。" : "当前没有可用动作。";
      elements["action-menu"].appendChild(empty);
      return;
    }
    types.forEach(function (type) {
      var group = document.createElement("section");
      group.className = "action-group";
      var heading = document.createElement("div");
      heading.className = "action-group-title";
      var title = document.createElement("span");
      title.textContent = labelForType(type);
      heading.appendChild(title);
      var count = document.createElement("span");
      count.textContent = String(actionIndex.byType.get(type).length);
      heading.appendChild(count);
      group.appendChild(heading);
      var list = document.createElement("div");
      list.className = "action-list";
      actionIndex.byType.get(type).forEach(function (action) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "action-button";
        button.setAttribute("data-action-type", safeText(action.type, "UNKNOWN"));
        button.setAttribute("data-action-key", Model.actionKey(action));
        button.textContent = actionLabel(action);
        button.addEventListener("click", function () { submitRawAction(action); });
        list.appendChild(button);
      });
      group.appendChild(list);
      elements["action-menu"].appendChild(group);
    });
  }

  function actionLabel(action) {
    if (!isObject(action)) {
      return "未知动作";
    }
    if (action.type === "MULLIGAN") {
      var ids = asArray(action.mulligan_entity_ids);
      return ids.length ? "替换 " + ids.map(labelForEntity).join("、") : "保留全部手牌";
    }
    if (action.type === "CHOOSE") {
      return "选择 " + labelForEntity(action.choice_entity_id);
    }
    if (action.type === "PLAY_CARD") {
      return "打出 " + labelForEntity(action.source_entity_id) + actionSuffix(action);
    }
    if (action.type === "ATTACK") {
      return "用 " + labelForEntity(action.source_entity_id) + " 攻击 " + labelForEntity(action.target_entity_id);
    }
    if (action.type === "USE_HERO_POWER") {
      return "使用技能 " + labelForEntity(action.source_entity_id) + actionSuffix(action);
    }
    if (action.type === "END_TURN") {
      return "结束回合";
    }
    return labelForType(action.type);
  }

  function actionSuffix(action) {
    var suffix = [];
    if (action.choose_option_entity_id !== undefined) {
      suffix.push(" · " + labelForEntity(action.choose_option_entity_id));
    }
    if (action.target_entity_id !== undefined) {
      suffix.push(" → " + labelForEntity(action.target_entity_id));
    }
    if (action.position !== undefined) {
      suffix.push(" · " + positionLabel(action.position));
    }
    return suffix.join("");
  }

  function renderLog(events) {
    var latestEventSeq = guiState.current.latestEventSeq;
    clear(elements["event-log"]);
    var list = asArray(events).slice().reverse();
    if (!list.length) {
      var empty = document.createElement("li");
      empty.className = "empty-log";
      empty.textContent = "对局事件会显示在这里。";
      elements["event-log"].appendChild(empty);
      return;
    }
    list.forEach(function (event) {
      var item = document.createElement("li");
      item.className = "event-item" + (safeNumber(event.seq, -1) === latestEventSeq ? " latest" : "");
      var actor = document.createElement("span");
      actor.className = "event-actor " + (event.actor === "opponent" ? "opponent" : "self");
      actor.textContent = event.actor === "opponent" ? "对手" : "你";
      item.appendChild(actor);
      var message = document.createElement("span");
      message.textContent = eventText(event);
      item.appendChild(message);
      if (event.turn !== undefined && event.turn !== null) {
        var turn = document.createElement("span");
        turn.className = "event-turn";
        turn.textContent = "回合 " + String(event.turn);
        item.appendChild(turn);
      }
      elements["event-log"].appendChild(item);
    });
  }

  function eventText(event) {
    if (!isObject(event)) {
      return "发生了一个公开事件";
    }
    var type = labelForType(event.type);
    function visibleName(id, fallback) {
      var card = findVisibleEntity(id);
      return card ? cardName(card) : safeText(fallback, "目标");
    }
    if (event.type === "PLAY_CARD") {
      return "打出 " + visibleName(event.source_entity_id, event.source_name || "一张卡牌") + (event.position !== undefined ? "（位置 " + String(event.position) + "）" : "");
    }
    if (event.type === "ATTACK") {
      return visibleName(event.source_entity_id, event.source_name || "随从") + " 攻击 " + visibleName(event.target_entity_id, event.target_name || "目标");
    }
    if (event.type === "USE_HERO_POWER") {
      return "使用英雄技能" + (event.target_name ? " → " + visibleName(event.target_entity_id, event.target_name) : "");
    }
    if (event.type === "MULLIGAN") {
      return "完成换牌";
    }
    if (event.type === "CHOOSE") {
      return "完成选择" + (event.source_name ? "：" + String(event.source_name) : "");
    }
    return type;
  }

  function renderOutcome(outcome, phase) {
    var snapshot = guiState.current.snapshot;
    if (!isObject(outcome) || phase !== "GAME_OVER") {
      setHidden(elements["game-over"], true);
      return;
    }
    var winner = outcome.winner === null || outcome.winner === undefined ? null : String(outcome.winner);
    var message = winner ? (outcome.human_won === true ? "你赢了！" : "对手获胜。") : "这局是平局。";
    setText(elements["game-over-message"], message + (winner ? "（" + winner + "）" : ""));
    setHidden(elements["game-over"], guiState.current.outcomeDismissedRevision === snapshot.revision);
    showNotice("对局结束：" + message, "outcome", 0);
  }

  function openCardModal(card) {
    if (!isObject(card)) {
      return;
    }
    clear(elements["modal-art"]);
    elements["modal-art"].appendChild(createCardArt(card, "render"));
    setText(elements["modal-card-name"], cardName(card));
    setText(elements["modal-card-id"], safeText(card.card_id, ""));
    clear(elements["modal-stats"]);
    if (card.cost !== undefined) {
      elements["modal-stats"].appendChild(createStat("cost", "费用", card.cost));
    }
    if (card.atk !== undefined) {
      elements["modal-stats"].appendChild(createStat("attack", "攻击", card.atk));
    }
    if (card.health !== undefined) {
      elements["modal-stats"].appendChild(createStat("health", "生命", card.health));
    }
    if (card.durability !== undefined) {
      elements["modal-stats"].appendChild(createStat("durability", "耐久", card.durability));
    }
    setText(elements["modal-card-text"], cardText(card) || "暂无本地卡牌文本");
    setHidden(elements["card-modal"], false);
    elements["modal-close"].focus();
  }

  function closeCardModal() {
    setHidden(elements["card-modal"], true);
  }

  window.addEventListener("DOMContentLoaded", init);
  window.fireplaceWebGui = {
    loadState: loadState,
    submitAction: submitAction,
    cancelSelection: cancelSelection,
  };
}());
