(function () {
  "use strict";

  // Render only the public, JSON-safe effect summary in an Observation.
  function text(value) {
    return typeof value === "string" ? value : "";
  }

  function number(value) {
    return Number.isFinite(value) ? value : null;
  }

  function statChanges(card) {
    var pairs = [
      { key: "attack", printed: card.printed_atk, current: card.atk },
      { key: "health", printed: card.printed_health, current: card.max_health },
      { key: "cost", printed: card.printed_cost, current: card.cost },
      { key: "durability", printed: card.printed_durability, current: card.max_durability === undefined
        ? card.durability : card.max_durability },
    ];
    return pairs.filter(function (pair) {
      return number(pair.printed) !== null && number(pair.current) !== null &&
        pair.printed !== pair.current;
    });
  }

  function appendLabeledText(parent, className, label, value) {
    var line = document.createElement("p");
    line.className = className;
    var heading = document.createElement("span");
    heading.className = "modifier-label";
    heading.textContent = label;
    if (label) {
      line.appendChild(heading);
    }
    line.appendChild(document.createTextNode(value));
    parent.appendChild(line);
  }

  function renderDetails(container, card, tr) {
    container.replaceChildren();
    var changes = statChanges(card);
    var modifiers = Array.isArray(card.active_modifiers) ? card.active_modifiers : [];
    container.hidden = !changes.length && !modifiers.length;
    if (container.hidden) {
      return;
    }

    var heading = document.createElement("h3");
    heading.textContent = tr("modifierDetails");
    container.appendChild(heading);

    changes.forEach(function (change) {
      var row = document.createElement("p");
      row.className = "modifier-stat-change";
      row.textContent = tr(change.key) + "  " + change.printed + " → " + change.current;
      container.appendChild(row);
    });

    if (modifiers.length) {
      var effectsHeading = document.createElement("h4");
      effectsHeading.textContent = tr("activeEffects");
      container.appendChild(effectsHeading);
    } else if (changes.length) {
      appendLabeledText(container, "modifier-unattributed", "", tr("modifierSourceUnknown"));
    }

    modifiers.forEach(function (modifier) {
      var row = document.createElement("div");
      row.className = "modifier-entry";
      var effect = modifier.effect && typeof modifier.effect === "object" ? modifier.effect : null;
      var source = modifier.source && typeof modifier.source === "object" ? modifier.source : null;
      var effectName = text(effect && effect.name);
      var sourceName = text(source && source.name);
      var title = document.createElement("strong");
      title.textContent = effectName || sourceName || tr("unknownEffect");
      row.appendChild(title);
      if (sourceName) {
        appendLabeledText(row, "modifier-source", tr("modifierSource"), sourceName);
      }
      var grants = Array.isArray(modifier.grants) ? modifier.grants : [];
      if (grants.includes("deathrattle")) {
        appendLabeledText(row, "modifier-grant", tr("modifierGrants"), tr("deathrattle"));
      }
      var rules = text(effect && effect.text) || text(source && source.text);
      if (rules) {
        appendLabeledText(row, "modifier-rules", "", rules.replace(/<[^>]*>/g, ""));
      }
      container.appendChild(row);
    });
  }

  window.FireplaceModifierView = { renderDetails: renderDetails };
}());
