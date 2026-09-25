(function (global) {
  "use strict";

  /*
   * The browser never constructs an Action.  This small module only indexes
   * the JSON values supplied by the server and returns the original object
   * references when a selection is made.  Keeping this logic DOM-free makes
   * the decision boundary easy to exercise without a browser and, more
   * importantly, prevents a UI selection from silently changing an action
   * value before it is submitted.
   */

  var ACTION_ORDER = [
    "MULLIGAN",
    "CHOOSE",
    "PLAY_CARD",
    "ATTACK",
    "USE_HERO_POWER",
    "END_TURN",
  ];

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function id(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function idKey(value) {
    var entityId = id(value);
    return entityId === null ? null : String(entityId);
  }

  function sameId(left, right) {
    var leftId = id(left);
    var rightId = id(right);
    return leftId !== null && rightId !== null && leftId === rightId;
  }

  function copyArray(value) {
    return asArray(value).slice();
  }

  function groupBy(actions, fieldName) {
    var groups = new Map();
    actions.forEach(function (action) {
      if (!isObject(action)) {
        return;
      }
      var key = idKey(action[fieldName]);
      if (key === null) {
        return;
      }
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(action);
    });
    return groups;
  }

  function index(actions) {
    var list = asArray(actions);
    var byType = new Map();
    list.forEach(function (action) {
      if (!isObject(action)) {
        return;
      }
      var type = typeof action.type === "string" ? action.type : "UNKNOWN";
      if (!byType.has(type)) {
        byType.set(type, []);
      }
      byType.get(type).push(action);
    });
    return {
      actions: list,
      byType: byType,
      bySource: groupBy(list, "source_entity_id"),
      byTarget: groupBy(list, "target_entity_id"),
      mulligan: copyArray(byType.get("MULLIGAN")),
      choices: copyArray(byType.get("CHOOSE")),
      endTurn: copyArray(byType.get("END_TURN")),
    };
  }

  function filter(actions, criteria) {
    var result = asArray(actions).filter(function (action) {
      if (!isObject(action)) {
        return false;
      }
      var expected = criteria || {};
      if (expected.type && action.type !== expected.type) {
        return false;
      }
      if (expected.source_entity_id !== undefined && !sameId(action.source_entity_id, expected.source_entity_id)) {
        return false;
      }
      if (expected.target_entity_id !== undefined && !sameId(action.target_entity_id, expected.target_entity_id)) {
        return false;
      }
      if (expected.choose_option_entity_id !== undefined && !sameId(action.choose_option_entity_id, expected.choose_option_entity_id)) {
        return false;
      }
      if (expected.choice_entity_id !== undefined && !sameId(action.choice_entity_id, expected.choice_entity_id)) {
        return false;
      }
      if (expected.position !== undefined && action.position !== expected.position) {
        return false;
      }
      return true;
    });
    return result;
  }

  function uniqueValues(actions, fieldName) {
    var values = [];
    var seen = new Set();
    asArray(actions).forEach(function (action) {
      if (!isObject(action) || action[fieldName] === undefined || action[fieldName] === null) {
        return;
      }
      var value = action[fieldName];
      var key = fieldName === "position" ? String(value) : idKey(value);
      if (key === null || seen.has(key)) {
        return;
      }
      seen.add(key);
      values.push(value);
    });
    return values;
  }

  function actionKey(action) {
    if (!isObject(action)) {
      return "";
    }
    return [
      action.type,
      action.source_entity_id === undefined ? "" : action.source_entity_id,
      action.target_entity_id === undefined ? "" : action.target_entity_id,
      action.choose_option_entity_id === undefined ? "" : action.choose_option_entity_id,
      action.position === undefined ? "" : action.position,
      action.choice_entity_id === undefined ? "" : action.choice_entity_id,
      asArray(action.mulligan_entity_ids).join(","),
    ].join("|");
  }

  function findByField(actions, fieldName, value) {
    return asArray(actions).filter(function (action) {
      return isObject(action) && sameId(action[fieldName], value);
    });
  }

  function mulliganKey(entityIds) {
    return asArray(entityIds).map(id).filter(function (value) {
      return value !== null;
    }).sort(function (left, right) {
      return left - right;
    }).join(",");
  }

  function findMulligan(indexed, entityIds) {
    var wanted = mulliganKey(entityIds);
    return asArray(indexed && indexed.mulligan).find(function (action) {
      return mulliganKey(action.mulligan_entity_ids) === wanted;
    }) || null;
  }

  function findChoice(indexed, choiceId) {
    return asArray(indexed && indexed.choices).find(function (action) {
      return sameId(action.choice_entity_id, choiceId);
    }) || null;
  }

  function sourceActions(indexed, type, sourceId) {
    var actions = indexed && indexed.byType ? indexed.byType.get(type) : [];
    return findByField(actions, "source_entity_id", sourceId);
  }

  function sortTypes(types) {
    return copyArray(types).sort(function (left, right) {
      var leftIndex = ACTION_ORDER.indexOf(left);
      var rightIndex = ACTION_ORDER.indexOf(right);
      return (leftIndex < 0 ? ACTION_ORDER.length : leftIndex) -
        (rightIndex < 0 ? ACTION_ORDER.length : rightIndex);
    });
  }

  function actionTypes(indexed) {
    return sortTypes(Array.from(indexed && indexed.byType ? indexed.byType.keys() : []));
  }

  global.FireplaceActionModel = {
    ACTION_ORDER: ACTION_ORDER.slice(),
    actionKey: actionKey,
    actionTypes: actionTypes,
    filter: filter,
    findChoice: findChoice,
    findMulligan: findMulligan,
    id: id,
    idKey: idKey,
    index: index,
    sameId: sameId,
    sourceActions: sourceActions,
    uniqueValues: uniqueValues,
  };
}(window));
