(function () {
  "use strict";

  var API_STATE = "/api/state";
  var API_ACTION = "/api/action";
  var API_START = "/api/start";
  var API_RETURN = "/api/return";
  var Model = window.FireplaceActionModel;
  var StatusView = window.FireplaceStatusView;
  var ModifierView = window.FireplaceModifierView;
  var elements = {};
  var guiState = createGuiState(Model);
  var busy = false;
  var currentLocale = normalizeLocale(readStored("fireplace.locale", "zhCN"));
  var requestGeneration = 0;
  var currentMode = "lobby";
  var currentOpponent = "random";
  var lobbyStage = "login";
  var noticeTimer = null;
  var pollTimer = null;
  var assetRequests = new Map();
  var inspectedCardRef = null;
  var attackPointer = null;
  var attackLine = null;
  var attackStroke = null;

  window.addEventListener("resize", refreshLiveStatsOverlays);

  window.addEventListener("beforeunload", function () {
    assetRequests.forEach(function (entry) {
      if (entry.objectUrl) {
        URL.revokeObjectURL(entry.objectUrl);
      }
    });
  });

  var FALLBACK_COPY = {
    "phase.MULLIGAN": "换牌",
    "phase.CHOICE": "选择",
    "phase.MAIN": "主阶段",
    "phase.GAME_OVER": "对局结束",
    "unknownCard": "未知卡牌",
    "unknownAction": "未知动作",
    "target": "目标",
  };

  function normalizeLocale(locale) {
    if (window.FireplaceI18n && typeof window.FireplaceI18n.normalizeLocale === "function") {
      return window.FireplaceI18n.normalizeLocale(locale);
    }
    return locale === "enUS" ? "enUS" : "zhCN";
  }

  function tr(key, variables) {
    if (window.FireplaceI18n && typeof window.FireplaceI18n.t === "function") {
      return window.FireplaceI18n.t(key, variables, currentLocale);
    }
    var value = FALLBACK_COPY[key] || key;
    return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, function (_, name) {
      return variables && variables[name] !== undefined ? String(variables[name]) : "{" + name + "}";
    });
  }

  function readStored(key, fallback) {
    try {
      var value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function writeStored(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      // Private browsing or disabled storage should not block a local match.
    }
  }

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
      "app-shell",
      "lobby-screen",
      "lobby-form",
      "lobby-title",
      "lobby-subtitle",
      "nickname-input",
      "nickname-label",
      "nickname-hint",
      "language-label",
      "locale-zhCN",
      "locale-enUS",
      "opponent-label",
      "opponent-random-option",
      "opponent-heuristic-option",
      "opponent-random-title",
      "opponent-random-description",
      "opponent-heuristic-title",
      "opponent-heuristic-description",
      "start-match-button",
      "lobby-status",
      "lobby-footer",
      "lobby-login-actions",
      "enter-lobby-button",
      "lobby-setup",
      "game",
      "table",
      "page-title",
      "brand-caption",
      "opponent-title",
      "self-title",
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
      "hand-title",
      "decision-title",
      "log-title",
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
      "game-over-return",
      "game-over-dismiss",
      "terminal-actions",
      "terminal-status",
      "terminal-return",
      "connection-value",
      "card-modal",
      "modal-close",
      "modal-art",
      "modal-card-name",
      "modal-card-id",
      "modal-stats",
      "modal-statuses",
      "modal-modifiers",
      "modal-card-text",
    ].forEach(function (id) {
      elements[id] = getElement(id);
    });

    bindLobbyControls();
    initAttackLine();

    elements["action-submit"].addEventListener("click", submitSelected);
    elements["selection-cancel"].addEventListener("click", cancelSelection);
    elements["end-turn-button"].addEventListener("click", submitEndTurn);
    elements["modal-close"].addEventListener("click", closeCardModal);
    elements["game-over-dismiss"].addEventListener("click", function () {
      guiState.current.outcomeDismissedRevision = guiState.current.snapshot ? guiState.current.snapshot.revision : null;
      setHidden(elements["game-over"], true);
      setHidden(elements["terminal-actions"], false);
    });
    elements["game-over-return"].addEventListener("click", returnHome);
    elements["terminal-return"].addEventListener("click", returnHome);
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

    applyLocaleToDocument();
    setLobbyFormValues();
    loadState(false);
    pollTimer = window.setInterval(function () {
      if (!busy) {
        pollState();
      }
    }, 2500);
  }

  function bindLobbyControls() {
    if (elements["lobby-form"]) {
      elements["lobby-form"].addEventListener("submit", function (event) {
        event.preventDefault();
        if (lobbyStage === "login") {
          enterLobby();
        } else {
          startMatch();
        }
      });
    }
    ["locale-zhCN", "locale-enUS"].forEach(function (id) {
      if (elements[id]) {
        elements[id].addEventListener("click", function () {
          if (currentMode === "match") {
            return;
          }
          setLocale(elements[id].getAttribute("data-locale"), true);
        });
      }
    });
    document.querySelectorAll("input[name=opponent]").forEach(function (input) {
      input.addEventListener("change", function () {
        currentOpponent = input.value === "heuristic" ? "heuristic" : "random";
        updateOpponentChoiceStyles();
      });
    });
  }

  function setLocale(locale, persist) {
    if (currentMode === "match" && locale !== currentLocale) {
      return;
    }
    currentLocale = normalizeLocale(locale);
    if (persist) {
      writeStored("fireplace.locale", currentLocale);
    }
    applyLocaleToDocument();
    updateLocaleControls();
    if (currentMode === "lobby") {
      renderLobby();
    } else if (guiState.current.snapshot) {
      renderSnapshot();
    }
  }

  function applyLocaleToDocument() {
    document.documentElement.lang = currentLocale === "enUS" ? "en" : "zh-CN";
    document.title = "Fireplace · " + tr("app.title");
    var description = document.querySelector("meta[name=description]");
    if (description) {
      description.setAttribute("content", tr("app.description"));
    }
    renderStaticCopy();
  }

  function setSelectorText(selector, value) {
    var node = document.querySelector(selector);
    if (node) {
      setText(node, value);
    }
  }

  function renderStaticCopy() {
    setText(elements["page-title"], tr("app.title"));
    setText(elements["brand-caption"], tr("app.caption"));
    setText(elements["opponent-title"], tr("opponent"));
    setText(elements["self-title"], tr("you"));
    setText(elements["hand-title"], tr("yourHand"));
    setText(elements["decision-title"], tr("decision"));
    setText(elements["log-title"], tr("matchLog"));
    setText(elements["game-over-return"], tr("returnHome"));
    setText(elements["game-over-dismiss"], tr("viewBoard"));
    setText(elements["terminal-status"], tr("terminalStatus"));
    setText(elements["terminal-return"], tr("returnHome"));
    setSelectorText(".opponent-panel .board-heading h3", tr("opponentBoard"));
    setSelectorText(".self-panel .board-heading h3", tr("yourBoard"));
    setSelectorText(".log-section .section-heading .muted", tr("logRecent"));
    setSelectorText(".game-over-card .eyebrow", tr("matchComplete"));
    setSelectorText(".game-over-card h2", tr("gameOver"));
    setSelectorText(".game-over-card .muted", tr("gameOverHint"));
    setSelectorText(".footer > span:first-child", tr("footer"));
    var fallbackSummary = document.querySelector("#action-fallback summary");
    if (fallbackSummary) {
      var fallbackCount = elements["fallback-count"];
      clear(fallbackSummary);
      fallbackSummary.appendChild(document.createTextNode(tr("fallback") + " "));
      if (fallbackCount) {
        fallbackSummary.appendChild(fallbackCount);
      }
    }
    setSelectorText(".modal-copy .eyebrow", tr("cardDetail"));
    if (elements["table"]) {
      elements["table"].setAttribute("aria-label", tr("yourBoard"));
    }
    if (elements["opponent-hand"]) {
      elements["opponent-hand"].setAttribute("aria-label", tr("opponentHandAria"));
    }
    if (elements["opponent-hand-count"]) {
      elements["opponent-hand-count"].setAttribute("aria-label", tr("opponentHandCount"));
    }
    if (elements["opponent-board"]) {
      elements["opponent-board"].setAttribute("aria-label", tr("opponentBoard"));
    }
    if (elements["self-board"]) {
      elements["self-board"].setAttribute("aria-label", tr("yourBoard"));
    }
    if (elements["hand"]) {
      elements["hand"].setAttribute("aria-label", tr("yourHand"));
    }
    var belowTools = document.querySelector(".below-board-tools");
    if (belowTools) {
      belowTools.setAttribute("aria-label", tr("backupActions"));
    }
    if (elements["modal-close"]) {
      elements["modal-close"].setAttribute("aria-label", tr("close"));
    }
    if (elements["opponent-mana-value"]) {
      elements["opponent-mana-value"].setAttribute("aria-label", tr("opponentManaAria"));
    }
    if (elements["mana-value"]) {
      elements["mana-value"].setAttribute("aria-label", tr("yourManaAria"));
    }
    if (elements["opponent-extras"]) {
      elements["opponent-extras"].setAttribute("aria-label", tr("opponentExtrasAria"));
    }
    if (elements["self-extras"]) {
      elements["self-extras"].setAttribute("aria-label", tr("yourExtrasAria"));
    }
    if (elements["choice-options"]) {
      elements["choice-options"].setAttribute("aria-label", tr("choiceOptions"));
    }
    if (elements["quick-actions"]) {
      elements["quick-actions"].setAttribute("aria-label", tr("quickActions"));
    }
    if (elements["position-choices"]) {
      elements["position-choices"].setAttribute("aria-label", tr("positions"));
    }
  }

  function updateLocaleControls() {
    ["zhCN", "enUS"].forEach(function (locale) {
      var button = elements["locale-" + locale];
      if (!button) {
        return;
      }
      var selected = locale === currentLocale;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function setLobbyFormValues() {
    if (!elements["nickname-input"]) {
      return;
    }
    elements["nickname-input"].value = readStored("fireplace.nickname", "");
    setLobbyStage(elements["nickname-input"].value.trim() ? "setup" : "login");
    var checked = document.querySelector("input[name=opponent]:checked");
    currentOpponent = checked && checked.value === "heuristic" ? "heuristic" : "random";
    updateLocaleControls();
    updateOpponentChoiceStyles();
  }

  function updateOpponentChoiceStyles() {
    ["random", "heuristic"].forEach(function (opponent) {
      var input = document.querySelector("input[name=opponent][value=" + opponent + "]");
      var option = elements["opponent-" + opponent + "-option"];
      var selected = Boolean(input && input.checked);
      if (option) {
        option.classList.toggle("is-selected", selected);
      }
    });
  }

  function setLobbyStage(stage) {
    lobbyStage = stage === "setup" ? "setup" : "login";
    setHidden(elements["lobby-login-actions"], lobbyStage !== "login");
    setHidden(elements["lobby-setup"], lobbyStage !== "setup");
    if (elements["enter-lobby-button"]) {
      setText(elements["enter-lobby-button"], tr("lobby.enter"));
    }
  }

  function setLobbyStatus(message, kind) {
    setText(elements["lobby-status"], message || "");
    if (elements["lobby-status"]) {
      elements["lobby-status"].className = "lobby-status" + (kind ? " " + kind : "");
    }
  }

  function setScreen(mode) {
    currentMode = mode === "match" ? "match" : "lobby";
    setHidden(elements["lobby-screen"], currentMode !== "lobby");
    setHidden(elements["game"], currentMode !== "match");
    if (currentMode === "lobby") {
      setHidden(elements["game-over"], true);
      setHidden(elements["terminal-actions"], true);
      updateLocaleControls();
    }
  }

  function clearMatchState() {
    guiState.current.snapshot = null;
    guiState.current.actionIndex = Model.index([]);
    guiState.resetSelection();
    guiState.current.fingerprint = "";
    guiState.current.latestEventSeq = null;
    guiState.current.outcomeDismissedRevision = null;
    inspectedCardRef = null;
    setHidden(elements["card-modal"], true);
    setHidden(elements["terminal-actions"], true);
    assetRequests.forEach(function (entry) {
      entry.cancelled = true;
      if (entry.objectUrl) {
        URL.revokeObjectURL(entry.objectUrl);
      }
    });
    assetRequests.clear();
    renderEmptyState();
  }

  function renderLobby() {
    setScreen("lobby");
    setText(elements["lobby-title"], tr("lobby.title"));
    setText(elements["lobby-subtitle"], tr("lobby.subtitle"));
    setText(elements["nickname-label"], tr("lobby.nickname"));
    setText(elements["nickname-hint"], tr("lobby.nicknameHint"));
    setText(elements["language-label"], tr("lobby.language"));
    setText(elements["opponent-label"], tr("lobby.opponent"));
    setText(elements["opponent-random-title"], tr("lobby.random"));
    setText(elements["opponent-random-description"], tr("lobby.randomDescription"));
    setText(elements["opponent-heuristic-title"], tr("lobby.heuristic"));
    setText(elements["opponent-heuristic-description"], tr("lobby.heuristicDescription"));
    setText(elements["start-match-button"], tr("lobby.start"));
    setText(elements["lobby-footer"], tr("lobby.footer"));
    if (elements["nickname-input"]) {
      elements["nickname-input"].placeholder = tr("lobby.nicknamePlaceholder");
    }
    updateLocaleControls();
    updateOpponentChoiceStyles();
    setLobbyStage(lobbyStage);
  }

  function enterLobby() {
    if (busy) {
      return;
    }
    var nickname = elements["nickname-input"] ? elements["nickname-input"].value.trim() : "";
    if (!nickname) {
      setLobbyStatus(tr("lobby.enterName"), "error");
      if (elements["nickname-input"]) {
        elements["nickname-input"].focus();
      }
      return;
    }
    writeStored("fireplace.nickname", nickname);
    setLobbyStage("setup");
    setLobbyStatus(tr("lobby.serverReady"));
  }

  function startMatch() {
    if (busy) {
      return;
    }
    if (lobbyStage !== "setup") {
      enterLobby();
      return;
    }
    var nickname = elements["nickname-input"] ? elements["nickname-input"].value.trim() : "";
    if (!nickname) {
      setLobbyStatus(tr("lobby.enterName"), "error");
      if (elements["nickname-input"]) {
        elements["nickname-input"].focus();
      }
      return;
    }
    writeStored("fireplace.nickname", nickname);
    currentOpponent = document.querySelector("input[name=opponent]:checked") &&
      document.querySelector("input[name=opponent]:checked").value === "heuristic" ? "heuristic" : "random";
    var generation = ++requestGeneration;
    busy = true;
    if (elements["start-match-button"]) {
      elements["start-match-button"].disabled = true;
    }
    setLobbyStatus(tr("lobby.starting"));
    setConnection(tr("status.connecting"), false);
    fetch(API_START, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nickname: nickname, opponent: currentOpponent, locale: currentLocale }),
    })
      .then(readJsonResponse)
      .then(function (payload) {
        if (generation !== requestGeneration) {
          return;
        }
        var envelope = normalizeServerPayload(payload);
        if (!envelope.snapshot) {
          throw new Error(tr("stateMissing"));
        }
        currentLocale = normalizeLocale(envelope.locale || currentLocale);
        applyLocaleToDocument();
        clearMatchState();
        applySnapshot(envelope.snapshot, { resetSelection: true });
        setScreen("match");
        setConnection(tr("status.connected"), false);
      })
      .catch(function (error) {
        if (generation !== requestGeneration) {
          return;
        }
        setLobbyStatus(tr("lobby.startFailed", { message: errorMessage(error) }), "error");
        setConnection(tr("status.disconnected"), true);
      })
      .finally(function () {
        if (generation !== requestGeneration) {
          return;
        }
        busy = false;
        if (elements["start-match-button"]) {
          elements["start-match-button"].disabled = false;
        }
      });
  }

  function returnHome() {
    var snapshot = guiState.current.snapshot;
    if (busy || !snapshot || !snapshot.outcome) {
      return;
    }
    var generation = ++requestGeneration;
    busy = true;
    setConnection(tr("status.submitting"), false);
    fetch(API_RETURN, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: snapshot.session_id, revision: snapshot.revision }),
    })
      .then(readJsonResponse)
      .then(function (payload) {
        if (generation !== requestGeneration) {
          return;
        }
        var envelope = normalizeServerPayload(payload);
        if (envelope.mode !== "lobby") {
          throw new Error(tr("stateMissing"));
        }
        currentLocale = normalizeLocale(envelope.locale || currentLocale);
        applyLocaleToDocument();
        clearMatchState();
        setLobbyFormValues();
        setLobbyStatus(tr("lobby.waiting"));
        renderLobby();
        setConnection(tr("status.connected"), false);
      })
      .catch(function (error) {
        if (generation !== requestGeneration) {
          return;
        }
        showNotice(tr("lobby.returnFailed", { message: errorMessage(error) }), "error", 0);
      })
      .finally(function () {
        if (generation === requestGeneration) {
          busy = false;
        }
      });
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
      return tr("unknownCard");
    }
    return safeText(card.name, safeText(card.card_id, tr("unknownCard")));
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
    var labels = {
      MULLIGAN: "replace",
      CHOOSE: "choose",
      PLAY_CARD: "play",
      ATTACK: "attackTarget",
      USE_HERO_POWER: "usePower",
      END_TURN: "endTurn",
    };
    return labels[type] ? tr(labels[type]) : safeText(type, tr("unknownAction"));
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
    return tr("unknownError");
  }

  function readJsonResponse(response) {
    return response.text().then(function (body) {
      var payload = {};
      if (body) {
        try {
          payload = JSON.parse(body);
        } catch (error) {
          throw new Error(tr("invalidJson", { value: response.status }));
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

  function normalizeServerPayload(payload) {
    if (!isObject(payload)) {
      return { mode: "unknown", locale: currentLocale, snapshot: null };
    }
    var mode = payload.mode === "lobby" ? "lobby" : "match";
    var locale = normalizeLocale(payload.locale || currentLocale);
    if (mode === "lobby") {
      return { mode: "lobby", locale: locale, snapshot: null, raw: payload };
    }
    var source = isObject(payload.snapshot) ? payload.snapshot : payload;
    return {
      mode: "match",
      locale: locale,
      snapshot: snapshotFromPayload(source),
      raw: payload,
    };
  }

  function snapshotFingerprint(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(Date.now());
    }
  }

  function applyServerPayload(payload, options) {
    var envelope = normalizeServerPayload(payload);
    if (envelope.mode === "lobby") {
      var enteredLobby = currentMode !== "lobby";
      if (enteredLobby || guiState.current.snapshot) {
        clearMatchState();
        if (enteredLobby) {
          setLobbyFormValues();
        }
      }
      var lobbyDefault = envelope.raw && (envelope.raw.default_opponent || envelope.raw.opponent);
      if (lobbyDefault === "random" || lobbyDefault === "heuristic") {
        currentOpponent = lobbyDefault;
        var defaultInput = document.querySelector("input[name=opponent][value=" + lobbyDefault + "]");
        if (defaultInput) {
          defaultInput.checked = true;
        }
        updateOpponentChoiceStyles();
      }
      currentLocale = normalizeLocale(envelope.locale || currentLocale);
      applyLocaleToDocument();
      renderLobby();
      return envelope;
    }
    if (!envelope.snapshot) {
      throw new Error(tr("stateMissing"));
    }
    if (currentMode !== "match") {
      clearMatchState();
    }
    /* Locale is selected before a match and locked once a match snapshot is
       received.  A server supplied locale is authoritative for refreshes. */
    currentLocale = normalizeLocale(envelope.locale || currentLocale);
    applyLocaleToDocument();
    if (guiState.isStale(envelope.snapshot)) {
      return envelope;
    }
    applySnapshot(envelope.snapshot, options || { resetSelection: guiState.isDecisionChanged(envelope.snapshot) });
    setScreen("match");
    return envelope;
  }

  function loadState(silent) {
    var generation = requestGeneration;
    if (!silent) {
      setConnection(tr("status.reading"), false);
    }
    return fetch(API_STATE, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(readJsonResponse)
      .then(function (payload) {
        if (generation !== requestGeneration) {
          return null;
        }
        var envelope = applyServerPayload(payload, { resetSelection: guiState.isDecisionChanged(normalizeServerPayload(payload).snapshot || {}) });
        setConnection(tr("status.connected"), false);
        return envelope.snapshot;
      })
      .catch(function (error) {
        if (generation !== requestGeneration) {
          return null;
        }
        setConnection(tr("status.disconnected"), true);
        if (!silent || (!guiState.current.snapshot && currentMode !== "lobby")) {
          showNotice(tr("stateUnavailable", { message: errorMessage(error) }), "error", 0);
          if (!guiState.current.snapshot) {
            renderLobby();
          }
        }
        return null;
      });
  }

  function pollState() {
    var generation = requestGeneration;
    fetch(API_STATE, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(readJsonResponse)
      .then(function (payload) {
        if (generation !== requestGeneration) {
          return;
        }
        var envelope = normalizeServerPayload(payload);
        if (envelope.mode === "lobby") {
          if (currentMode !== "lobby") {
            applyServerPayload(payload, { resetSelection: true });
          }
          setConnection(tr("status.connected"), false);
          return;
        }
        var next = envelope.snapshot;
        if (!next || guiState.isStale(next)) {
          return;
        }
        setConnection(tr("status.connected"), false);
        var fingerprint = snapshotFingerprint(next);
        if (fingerprint !== guiState.current.fingerprint) {
          var hadSnapshot = Boolean(guiState.current.snapshot);
          var decisionChanged = guiState.isDecisionChanged(next);
          applyServerPayload(payload, { resetSelection: decisionChanged });
          if (decisionChanged && hadSnapshot && !busy) {
            showNotice(tr("stateUpdated"), "", 3200);
          }
        }
      })
      .catch(function () {
        if (generation === requestGeneration) {
          setConnection(tr("status.disconnected"), true);
        }
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
    refreshOpenCardModal();
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
    StatusView.hideTooltip();
    setText(elements["phase-value"], tr("status.unavailable"));
    setText(elements["turn-value"], tr("status.turn", { value: "—" }));
    setText(elements["active-seat-value"], tr("status.active", { value: "—" }));
    setText(elements["revision-value"], tr("status.revision", { value: "—" }));
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
    setText(elements["turn-value"], observation.turn === null || observation.turn === undefined ? tr("status.turn", { value: "—" }) : tr("status.turn", { value: observation.turn }));
    var activeLabel = observation.active_seat === null || observation.active_seat === undefined
      ? "—"
      : String(observation.active_seat) + (observation.active_seat === 0 ? tr("status.youSuffix") : tr("status.opponentSuffix"));
    setText(elements["active-seat-value"], tr("status.active", { value: activeLabel }));
    setText(elements["revision-value"], tr("status.revision", { value: snapshot.revision }));
    setText(elements["mana-value"], manaText(self));
    setText(elements["opponent-mana-value"], manaText(opponent));
    setText(elements["opponent-hand-count"], tr("cardsInHand", { value: safeNumber(opponent.hand_count, 0) }));
    setText(elements["deck-count"], tr("deck", { value: safeNumber(self.deck_count, 0) }));
    setText(elements["self-board-count"], boardCountText(self.board));
    setText(elements["opponent-board-count"], boardCountText(opponent.board));
    setText(elements["action-count"], tr("actions", { value: actionIndex.actions.length }));
    setText(elements["fallback-count"], "(" + String(actionIndex.actions.length) + ")");

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
    return tr("phase." + phase, {}) || phase;
  }

  function manaText(player) {
    var mana = player && player.mana !== undefined ? player.mana : "—";
    var maxMana = player && player.max_mana !== undefined ? player.max_mana : "—";
    return String(mana) + " / " + String(maxMana) + " " + tr("mana");
  }

  function boardCountText(board) {
    var count = asArray(board).length;
    return tr("minions", { value: count });
  }

  function renderHiddenHand(count) {
    clear(elements["opponent-hand"]);
    var amount = Math.max(0, safeNumber(count, 0));
    for (var index = 0; index < amount; index += 1) {
      var card = document.createElement("span");
      card.className = "hidden-card";
      card.setAttribute("aria-label", tr("opponentHiddenCard", { value: index + 1 }));
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
    addEntityLabel(labels, self.hero, tr("yourHero") + ": " + cardName(self.hero));
    addEntityLabel(labels, self.hero_power, tr("skill") + ": " + cardName(self.hero_power));
    addEntityLabel(labels, opponent.hero, tr("opponentHero") + ": " + cardName(opponent.hero));
    addEntityLabel(labels, opponent.hero_power, tr("skill") + ": " + cardName(opponent.hero_power));
    asArray(self.hand).forEach(function (card) { addEntityLabel(labels, card, cardName(card)); });
    asArray(self.board).forEach(function (card) { addEntityLabel(labels, card, cardName(card)); });
    asArray(opponent.board).forEach(function (card) { addEntityLabel(labels, card, tr("opponent") + ": " + cardName(card)); });
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
      return tr("target");
    }
    return entityLabels().get(id) || tr("entity", { value: id });
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
      empty.textContent = tr("noHero");
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
    subtitle.textContent = own ? tr("yourHero") : tr("opponentHero");
    copy.appendChild(subtitle);
    if (!own && isObject(power)) {
      var powerSummary = document.createElement("p");
      powerSummary.className = "card-subtitle public-power";
      powerSummary.textContent = tr("skill") + ": " + cardName(power) +
        (power.cost === undefined || power.cost === null ? "" : " · " + tr("cost") + " " + String(power.cost));
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
      weaponText.textContent = tr("weapon") + ": " + cardName(weapon) + " · " +
        String(safeNumber(weapon.atk, 0)) + " " + tr("attack") + " / " +
        String(safeNumber(weapon.durability, 0)) + " " + tr("durability");
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
        secretButton.textContent = tr("secrets") + ": " + cardName(secret);
        secretButton.addEventListener("click", function () { openCardModal(secret); });
        container.appendChild(secretButton);
      });
    } else if (safeNumber(player.secrets_count, 0) > 0) {
      var hiddenSecrets = document.createElement("span");
      hiddenSecrets.className = "extra-chip secret-chip hidden-secret";
      hiddenSecrets.setAttribute("data-testid", "opponent-secret-count");
      hiddenSecrets.textContent = tr("opponentSecrets", { value: player.secrets_count });
      container.appendChild(hiddenSecrets);
    }
    setHidden(container, !container.childNodes.length);
  }

  function renderBoard(container, board, own) {
    StatusView.hideTooltip();
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
      StatusView.decorateBoardCard(wrapper, card, tr);
      var content = document.createElement("div");
      content.className = "card-content";
      content.appendChild(cardTitle(card));
      content.appendChild(createCharacterStats(card, true, true));
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
    button.setAttribute("aria-label", tr("positionNumber", { value: positionLabel(position) }));
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
    copy.appendChild(cardTitle(power, tr("skill") + ": "));
    var details = document.createElement("p");
    details.className = "card-subtitle";
    details.textContent = (power.cost === undefined || power.cost === null ? "" : tr("cost") + " " + String(power.cost) + " · ") +
      (power.is_usable ? tr("canUse") : (power.exhausted ? tr("usedThisTurn") : tr("notAvailable")));
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
      var playActions = phase === "MAIN"
        ? Model.sourceActions(guiState.current.actionIndex, "PLAY_CARD", id)
        : [];
      var canPlay = playActions.length > 0;
      var poweredUp = canPlay && Boolean(card && card.powered_up);
      var mulliganSelected = selection.mulliganIds.some(function (value) { return value === id; });
      var wrapper = createEntityCard(card, "card hand-card " + (canPlay ? "sourceable playable" : "") +
        (poweredUp ? " powered-up" : "") + (mulliganSelected ? " mulligan-selected" : ""), function () {
        if (phase === "MULLIGAN") {
          toggleMulligan(id);
        } else if (sourceTypes.length) {
          chooseSource(sourceTypes[0], id);
        }
      });
      wrapper.setAttribute("data-entity-id", String(id === null ? "" : id));
      wrapper.setAttribute("data-testid", "hand-card");
      wrapper.setAttribute("data-playable", canPlay ? "true" : "false");
      wrapper.setAttribute("data-powered-up", poweredUp ? "true" : "false");
      wrapper.setAttribute("aria-label", handCardLabel(card, canPlay, poweredUp));
      wrapper.appendChild(createCardArt(card, "render", { liveStats: true }));
      var content = document.createElement("div");
      content.className = "card-content";
      content.appendChild(cardTitle(card));
      if (asArray(card && card.choose_options).length) {
        content.appendChild(createBadge(tr("selectOne"), "branch-badge"));
      }
      appendCardText(content, card);
      wrapper.appendChild(content);
      elements["hand"].appendChild(wrapper);
    });
  }

  function optionalNumber(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    var number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function cardHealthValue(card) {
    if (!isObject(card)) {
      return null;
    }
    var health = optionalNumber(card.health);
    return health === null ? optionalNumber(card.max_health) : health;
  }

  function cardStatValues(card) {
    if (!isObject(card)) {
      return [];
    }
    var values = [];
    function add(name, label, current, printed, changeType) {
      var live = optionalNumber(current);
      if (live === null) {
        return;
      }
      values.push({
        name: name,
        label: label,
        current: live,
        printed: optionalNumber(printed),
        changeType: changeType,
      });
    }
    add("cost", tr("cost"), card.cost, card.printed_cost, "cost");
    add("attack", tr("attack"), card.atk, card.printed_atk, "stat");
    var durability = optionalNumber(card.durability);
    if (durability !== null) {
      add("durability", tr("durability"), durability, card.printed_durability, "stat");
    } else {
      add("health", tr("health"), cardHealthValue(card), card.printed_health, "stat");
    }
    return values;
  }

  function statChangeClass(value) {
    if (value.printed === null || value.current === value.printed) {
      return "unchanged";
    }
    if (value.changeType === "cost") {
      return value.current < value.printed ? "cost-lower" : "cost-higher";
    }
    return value.current > value.printed ? "stat-higher" : "stat-lower";
  }

  function handCardLabel(card, canPlay, poweredUp) {
    var parts = [cardName(card)];
    cardStatValues(card).forEach(function (value) {
      var detail = tr("handStatCurrent", { name: value.label, value: value.current });
      if (value.printed !== null && value.current !== value.printed) {
        detail += " " + tr("handStatPrinted", { name: value.label, value: value.printed });
        detail += " " + tr(value.current > value.printed ? "handStatIncreased" : "handStatDecreased");
      }
      parts.push(detail);
    });
    if (canPlay) {
      parts.push(tr("play"));
    }
    if (poweredUp) {
      parts.push(tr("handConditionMet"));
    }
    return parts.join(currentLocale === "enUS" ? ", " : "，");
  }

  function createLiveStatsOverlay(card) {
    var values = cardStatValues(card);
    if (!values.length) {
      return null;
    }
    var overlay = document.createElement("div");
    overlay.className = "card-live-stats";
    overlay.setAttribute("aria-hidden", "true");
    values.forEach(function (value) {
      var node = document.createElement("span");
      node.className = "card-live-stat card-live-stat-" + value.name + " " + statChangeClass(value);
      node.textContent = String(value.current);
      node.title = value.label + " " + String(value.current);
      overlay.appendChild(node);
    });
    return overlay;
  }

  function resetLiveStatsOverlay(overlay) {
    if (!overlay) {
      return;
    }
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
  }

  function syncLiveStatsOverlay(art, image, overlay) {
    if (!art || !image || !overlay) {
      return;
    }
    var artWidth = art.clientWidth;
    var artHeight = art.clientHeight;
    var imageWidth = image.naturalWidth;
    var imageHeight = image.naturalHeight;
    if (!artWidth || !artHeight || image.hidden || !imageWidth || !imageHeight) {
      resetLiveStatsOverlay(overlay);
      return;
    }
    var scale = Math.min(artWidth / imageWidth, artHeight / imageHeight);
    var renderedWidth = imageWidth * scale;
    var renderedHeight = imageHeight * scale;
    overlay.style.top = ((artHeight - renderedHeight) / 2) + "px";
    overlay.style.left = ((artWidth - renderedWidth) / 2) + "px";
    overlay.style.width = renderedWidth + "px";
    overlay.style.height = renderedHeight + "px";
  }

  function refreshLiveStatsOverlays() {
    document.querySelectorAll(".card-live-stats").forEach(function (overlay) {
      var art = overlay.parentElement;
      var image = art && art.querySelector("img");
      syncLiveStatsOverlay(art, image, overlay);
    });
  }

  function createEntityCard(card, className, onSelect) {
    var wrapper = document.createElement("article");
    wrapper.className = className + " card-zoomable";
    wrapper.setAttribute("aria-label", cardName(card));
    wrapper.title = tr("viewCard", { value: cardName(card) });
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
    inspect.setAttribute("aria-label", tr("viewCard", { value: cardName(card) }));
    inspect.setAttribute("data-testid", "card-inspect");
    inspect.addEventListener("click", function (event) {
      event.stopPropagation();
      openCardModal(card);
    });
    wrapper.appendChild(inspect);
    return wrapper;
  }

  function createCardArt(card, kind, options) {
    var art = document.createElement("div");
    art.className = "card-art asset-placeholder";
    var liveStats = options && options.liveStats ? createLiveStatsOverlay(card) : null;
    var cardId = isObject(card) ? card.card_id : null;
    if (cardId) {
      var image = document.createElement("img");
      image.alt = cardName(card) + " " + tr("cardArt");
      image.loading = "lazy";
      image.hidden = true;
      var preferredKind = kind || "render";
      var imageRank = -1;
      image.addEventListener("load", function () {
        art.classList.remove("asset-placeholder");
        syncLiveStatsOverlay(art, image, liveStats);
      });
      image.addEventListener("error", function () {
        image.hidden = true;
        art.classList.add("asset-placeholder");
        resetLiveStatsOverlay(liveStats);
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
    if (liveStats) {
      art.appendChild(liveStats);
      syncLiveStatsOverlay(art, cardId ? art.querySelector("img") : null, liveStats);
    }
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
      stats.appendChild(createStat("attack", tr("attack"), character.atk));
    }
    if (character.health !== undefined) {
      var health = !compactHealth && character.max_health !== undefined && character.max_health !== null
        ? String(character.health) + " / " + String(character.max_health)
        : character.health;
      var healthStat = createStat("health", tr("health"), health);
      if (compactHealth && character.max_health !== undefined && character.max_health !== null) {
        healthStat.setAttribute("aria-label", tr("health") + " " + String(character.health) + " / " + String(character.max_health));
        healthStat.title = tr("health") + " " + String(character.health) + " / " + String(character.max_health);
      }
      stats.appendChild(healthStat);
    }
    if (character.armor !== undefined && character.armor) {
      stats.appendChild(createStat("armor", tr("armor"), character.armor));
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
        showNotice(tr("oldAction"), "error", 3600);
      }
      return;
    }
    var candidates = selectedActions();
    if (candidates.length === 1 && !actionRequiresSelection(candidates[0])) {
      submitRawAction(candidates[0]);
    } else {
      showNotice(tr("selectionRequired"), "error", 2800);
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
      showNotice(tr("oldAction"), "error", 3600);
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
      showNotice(tr("staleRevision"), "error", 0);
      loadState(false);
      return;
    }
    var generation = requestGeneration;
    busy = true;
    setButtonsDisabled(true);
    setConnection(tr("status.submitting"), false);
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
        if (generation !== requestGeneration) {
          return;
        }
        var envelope = applyServerPayload(payload, { resetSelection: true });
        if (envelope.mode !== "match" || !envelope.snapshot) {
          throw new Error(tr("actionMissing"));
        }
        setConnection(tr("status.connected"), false);
      })
      .catch(function (error) {
        if (generation !== requestGeneration) {
          return;
        }
        var synced = false;
        if (error && error.payload) {
          var errorEnvelope = normalizeServerPayload(error.payload);
          if (errorEnvelope.mode === "lobby" || errorEnvelope.snapshot) {
            applyServerPayload(error.payload, { resetSelection: true });
            synced = true;
          }
        }
        if (error && error.status === 409) {
          showNotice(tr("staleAction"), "error", 0);
        } else {
          showNotice(tr("submitFailed", { message: errorMessage(error) }), "error", 0);
        }
        if (error && error.status === 409 && synced) {
          setConnection(tr("status.connected"), false);
        } else {
          setConnection(error && error.status ? tr("status.rejected") : tr("status.disconnected"), true);
        }
        if (!synced) {
          loadState(false);
        }
      })
      .finally(function () {
        if (generation !== requestGeneration) {
          return;
        }
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
      setText(elements["action-instructions"], tr("loadingMatch"));
      return;
    }
    if (phase === "GAME_OVER") {
      setText(elements["action-instructions"], tr("gameOverInstruction"));
      return;
    }
    if (phase === "MULLIGAN") {
      setText(elements["action-instructions"], tr("mulliganInstruction"));
      renderPendingChoice(snapshot.observation.pending_choice);
      var mulliganAction = Model.findMulligan(actionIndex, selection.mulliganIds);
      setText(elements["action-submit"], mulliganAction ? tr("confirmMulligan") : tr("chooseMulligan"));
      setHidden(elements["action-submit"], false);
      return;
    }
    if (phase === "CHOICE") {
      setText(elements["action-instructions"], tr("selectOption"));
      renderPendingChoice(snapshot.observation.pending_choice);
      renderChoiceOptions(actionIndex.choices);
      return;
    }
    if (phase !== "MAIN") {
      setText(elements["action-instructions"], tr("waitingOpponent"));
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
        setText(elements["target-hint"], tr("chooseTarget"));
        setHidden(elements["target-hint"], false);
      }
      if (candidates.length === 1 && !actionRequiresSelection(candidates[0])) {
        setText(elements["action-submit"], tr("confirm") + " " + labelForType(candidates[0].type));
        setHidden(elements["action-submit"], false);
      }
      if (!candidates.length) {
        setText(elements["action-instructions"], tr("selectionInvalid"));
      }
    } else {
      setText(elements["action-instructions"], tr("mainInstruction"));
    }
  }

  function renderQuickActions() {
    var actionIndex = guiState.current.actionIndex;
    var groups = [
      { type: "PLAY_CARD", title: tr("play") },
      { type: "ATTACK", title: tr("attackTarget") },
      { type: "USE_HERO_POWER", title: tr("usePower") },
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
      return type === "PLAY_CARD"
        ? " · " + tr("handPosition", { value: position + 1 })
        : " · " + tr("boardPosition", { value: position + 1 });
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
      bounds.push(tr("atLeast", { value: choice.min_count }));
    }
    if (choice.max_count !== undefined) {
      bounds.push(tr("atMost", { value: choice.max_count }));
    }
    var text = document.createElement("span");
    text.textContent = tr("currentChoice") + (bounds.length ? " (" + bounds.join(", ") + ")" : "");
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
        button.textContent = tr("choose") + " " + labelForEntity(action.choice_entity_id);
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
      heading.textContent = tr("chooseBranch");
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
      positionHeading.textContent = tr("choosePosition");
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
      parts.push(tr("chooseBranch") + ": " + labelForEntity(selection.branchId));
    }
    if (selection.targetId !== null) {
      parts.push(tr("target") + ": " + labelForEntity(selection.targetId));
    }
    if (selection.position !== null) {
      parts.push(tr("position", { value: positionLabel(selection.position) }));
    }
    if (candidates.length > 1) {
      parts.push(tr("selectionNeedsMore"));
    }
    return parts.join("　");
  }

  function positionLabel(position) {
    var value = Number(position);
    if (value === 0) {
      return tr("positionLeft");
    }
    return tr("positionNumber", { value: value + 1 });
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
      empty.textContent = snapshot && snapshot.outcome ? tr("ended") : tr("noActions");
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
      return tr("unknownAction");
    }
    if (action.type === "MULLIGAN") {
      var ids = asArray(action.mulligan_entity_ids);
      return ids.length ? tr("replace") + " " + ids.map(labelForEntity).join(currentLocale === "enUS" ? ", " : "、") : tr("keepAll");
    }
    if (action.type === "CHOOSE") {
      return tr("choose") + " " + labelForEntity(action.choice_entity_id);
    }
    if (action.type === "PLAY_CARD") {
      return tr("play") + " " + labelForEntity(action.source_entity_id) + actionSuffix(action);
    }
    if (action.type === "ATTACK") {
      return tr("attackWith") + " " + labelForEntity(action.source_entity_id) + " " + tr("attackTarget") + " " + labelForEntity(action.target_entity_id);
    }
    if (action.type === "USE_HERO_POWER") {
      return tr("usePower") + " " + labelForEntity(action.source_entity_id) + actionSuffix(action);
    }
    if (action.type === "END_TURN") {
      return tr("endTurn");
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
      empty.textContent = tr("publicEvent");
      elements["event-log"].appendChild(empty);
      return;
    }
    list.forEach(function (event) {
      var item = document.createElement("li");
      item.className = "event-item" + (safeNumber(event.seq, -1) === latestEventSeq ? " latest" : "");
      var actor = document.createElement("span");
      actor.className = "event-actor " + (event.actor === "opponent" ? "opponent" : "self");
      actor.textContent = event.actor === "opponent" ? tr("eventOpponent") : tr("eventSelf");
      item.appendChild(actor);
      var message = document.createElement("span");
      message.textContent = eventText(event);
      item.appendChild(message);
      if (event.turn !== undefined && event.turn !== null) {
        var turn = document.createElement("span");
        turn.className = "event-turn";
        turn.textContent = tr("eventTurn", { value: event.turn });
        item.appendChild(turn);
      }
      elements["event-log"].appendChild(item);
    });
  }

  function eventText(event) {
    if (!isObject(event)) {
      return tr("publicEvent");
    }
    var type = labelForType(event.type);
    function visibleName(id, fallback) {
      var card = findVisibleEntity(id);
      return card ? cardName(card) : safeText(fallback, tr("target"));
    }
    if (event.type === "PLAY_CARD") {
      return tr("play") + " " + visibleName(event.source_entity_id, event.source_name || tr("unknownCard")) + (event.position !== undefined ? tr("playedAt", { value: event.position }) : "");
    }
    if (event.type === "ATTACK") {
      return visibleName(event.source_entity_id, event.source_name || tr("minions", { value: 1 })) + " " + tr("attackTarget") + " " + visibleName(event.target_entity_id, event.target_name || tr("target"));
    }
    if (event.type === "USE_HERO_POWER") {
      return tr("eventHeroPower") + (event.target_name ? tr("arrow") + visibleName(event.target_entity_id, event.target_name) : "");
    }
    if (event.type === "MULLIGAN") {
      return tr("eventMulligan");
    }
    if (event.type === "CHOOSE") {
      return tr("eventChoice") + (event.source_name ? (currentLocale === "enUS" ? ": " : "：") + String(event.source_name) : "");
    }
    return type;
  }

  function renderOutcome(outcome, phase) {
    var snapshot = guiState.current.snapshot;
    if (!isObject(outcome) || phase !== "GAME_OVER") {
      setHidden(elements["game-over"], true);
      setHidden(elements["terminal-actions"], true);
      return;
    }
    var winner = outcome.winner === null || outcome.winner === undefined ? null : String(outcome.winner);
    var message = winner ? (outcome.human_won === true ? tr("outcomeWon") : tr("outcomeLost")) : tr("outcomeDraw");
    var winnerLabel = outcomeWinnerLabel(winner);
    setText(elements["game-over-message"], message + (winnerLabel ? (currentLocale === "enUS" ? " (" + winnerLabel + ")" : "（" + winnerLabel + "）") : ""));
    var dismissed = guiState.current.outcomeDismissedRevision === snapshot.revision;
    setHidden(elements["game-over"], dismissed);
    setHidden(elements["terminal-actions"], !dismissed);
    showNotice(tr("outcomeNotice", { message: message }), "outcome", 0);
  }

  function outcomeWinnerLabel(winner) {
    if (!winner) {
      return "";
    }
    var normalized = String(winner).trim().toLowerCase();
    if (normalized === "random") {
      return tr("lobby.random");
    }
    if (normalized === "heuristic") {
      return tr("lobby.heuristic");
    }
    return String(winner);
  }

  function openCardModal(card) {
    if (!isObject(card)) {
      return;
    }
    inspectedCardRef = {
      entityId: entityId(card.entity_id),
      cardId: safeText(card.card_id, ""),
    };
    renderCardModal(card, true);
  }

  function renderCardModal(card, focusClose) {
    if (!isObject(card)) {
      return;
    }
    clear(elements["modal-art"]);
    elements["modal-art"].appendChild(createCardArt(card, "render", {
      liveStats: card.printed_cost !== undefined,
    }));
    setText(elements["modal-card-name"], cardName(card));
    setText(elements["modal-card-id"], safeText(card.card_id, ""));
    clear(elements["modal-stats"]);
    cardStatValues(card).forEach(function (value) {
      elements["modal-stats"].appendChild(createStat(value.name, value.label, value.current));
    });
    StatusView.renderDetails(elements["modal-statuses"], card, tr);
    setText(elements["modal-card-text"], cardText(card) || tr("noCardText"));
    ModifierView.renderDetails(elements["modal-modifiers"], card, tr);
    setHidden(elements["card-modal"], false);
    if (focusClose) {
      elements["modal-close"].focus();
    }
  }

  function refreshOpenCardModal() {
    if (!inspectedCardRef || !elements["card-modal"] || elements["card-modal"].hidden) {
      return;
    }
    var card = inspectedCardRef.entityId === null ? null : findVisibleEntity(inspectedCardRef.entityId);
    if (!card && inspectedCardRef.cardId) {
      var snapshot = guiState.current.snapshot;
      var visible = snapshot && snapshot.observation ? publicCharacters(snapshot.observation) : new Map();
      visible.forEach(function (candidate) {
        if (!card && candidate.card_id === inspectedCardRef.cardId) {
          card = candidate;
        }
      });
    }
    if (!card) {
      closeCardModal();
      return;
    }
    renderCardModal(card, false);
  }

  function closeCardModal() {
    inspectedCardRef = null;
    setHidden(elements["card-modal"], true);
  }

  window.addEventListener("DOMContentLoaded", init);
  window.fireplaceWebGui = {
    loadState: loadState,
    submitAction: submitAction,
    cancelSelection: cancelSelection,
  };
}());
