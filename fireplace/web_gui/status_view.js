(function () {
  "use strict";

  // This view reads only JSON scalars from an Observation. The order keeps the
  // statuses that change target selection or survival easiest to spot.
  var DEFINITIONS = [
    { field: "dormant", key: "dormant", icon: "hourglass" },
    { field: "taunt", key: "taunt", icon: "guard" },
    { field: "divine_shield", key: "shield", icon: "shield" },
    { field: "poisonous", key: "poisonous", icon: "poison" },
    { field: "has_deathrattle", key: "deathrattle", icon: "skull" },
    { field: "frozen", key: "frozen", icon: "snow" },
    { field: "stealthed", key: "stealth", icon: "eye" },
    { field: "lifesteal", key: "lifesteal", icon: "heart" },
    { field: "reborn", key: "reborn", icon: "cycle" },
    { field: "windfury", key: "windfury", icon: "wind" },
    { field: "rush", key: "rush", icon: "rush" },
    { field: "charge", key: "charge", icon: "bolt" },
    { field: "silenced", key: "silenced", icon: "mute" },
  ];
  var SVG_NS = "http://www.w3.org/2000/svg";
  var floatingTooltip = null;
  var tooltipHost = null;
  var PATHS = {
    hourglass: "M5 2h14M5 22h14M7 3c0 4 2 5 5 9-3 4-5 5-5 9m10-18c0 4-2 5-5 9 3 4 5 5 5 9M9 7h6m-3 7-3 4h6l-3-4Z",
    guard: "M12 2 3 6v6c0 5 3.6 8.2 9 10 5.4-1.8 9-5 9-10V6l-9-4Zm0 5v10M8 11h8",
    shield: "M12 2 4 6v6c0 4.6 3.1 8 8 10 4.9-2 8-5.4 8-10V6l-8-4Zm0 4v12m-5-6h10",
    poison: "M12 2c-2.5 4-7 8.5-7 13a7 7 0 0 0 14 0c0-4.5-4.5-9-7-13ZM8.5 15h7m-5-3 3 6m0-6-3 6",
    skull: "M12 2c-5 0-8 3.4-8 8.4 0 2.8 1.2 4.7 3 5.6v4h10v-4c1.8-.9 3-2.8 3-5.6C20 5.4 17 2 12 2ZM8.5 11h.1m6.8 0h.1M10 16v4m4-4v4",
    snow: "M12 2v20M4 6l16 12M20 6 4 18M9 5l3 3 3-3M9 19l3-3 3 3",
    eye: "M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Zm10-3a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM3 21 21 3",
    heart: "M12 21 4 13a5 5 0 0 1 7-7l1 1 1-1a5 5 0 0 1 7 7l-8 8Zm0-13v8m-4-4h8",
    cycle: "M20 10a8 8 0 1 0 .2 4M20 4v6h-6",
    wind: "M2 8h12a3 3 0 1 0-3-3M2 12h18M2 16h10a3 3 0 1 1-3 3",
    rush: "M3 18 16 5m-4 0h4v4M4 7h5M2 12h6M6 21h6",
    bolt: "M13 2 5 13h6l-1 9 9-12h-6l1-8Z",
    mute: "M3 9v6h4l5 4V5L7 9H3Zm13 0 5 6m0-6-5 6",
  };

  function icon(name) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", PATHS[name]);
    svg.appendChild(path);
    return svg;
  }

  function entries(card, tr) {
    if (!card || typeof card !== "object") {
      return [];
    }
    return DEFINITIONS.filter(function (definition) {
      return card[definition.field] === true;
    }).map(function (definition) {
      var label = tr(definition.key);
      if (definition.field === "dormant" && Number.isFinite(Number(card.dormant_turns))) {
        label += " · " + tr("dormantTurns", { value: Math.max(0, Number(card.dormant_turns)) });
      }
      return { field: definition.field, label: label, icon: definition.icon };
    });
  }

  function statusSlug(field) {
    return field === "has_deathrattle" ? "deathrattle" : field.replace(/_/g, "-");
  }

  function hideTooltip(host) {
    if (host && tooltipHost !== host) {
      return;
    }
    tooltipHost = null;
    if (floatingTooltip) {
      floatingTooltip.classList.remove("is-visible");
    }
  }

  function showTooltip(wrapper, statuses) {
    if (!floatingTooltip) {
      floatingTooltip = document.createElement("div");
      floatingTooltip.className = "keyword-tooltip";
      floatingTooltip.setAttribute("aria-hidden", "true");
      document.body.appendChild(floatingTooltip);
      window.addEventListener("scroll", function () { hideTooltip(); }, true);
      window.addEventListener("resize", function () { hideTooltip(); });
    }
    floatingTooltip.replaceChildren();
    statuses.forEach(function (status) {
      var row = document.createElement("span");
      row.appendChild(icon(status.icon));
      row.appendChild(document.createTextNode(status.label));
      floatingTooltip.appendChild(row);
    });
    tooltipHost = wrapper;
    floatingTooltip.classList.add("is-visible");
    var anchor = wrapper.getBoundingClientRect();
    var bounds = floatingTooltip.getBoundingClientRect();
    var left;
    var top;
    // On wide tables use the empty space beside a minion, so the tooltip
    // does not cover the other row of combat numbers.
    if (window.innerWidth >= 700 && anchor.left - bounds.width - 12 >= 8) {
      left = anchor.left - bounds.width - 12;
      top = Math.max(8, Math.min(window.innerHeight - bounds.height - 8, anchor.top));
    } else if (window.innerWidth >= 700 && anchor.right + bounds.width + 12 <= window.innerWidth - 8) {
      left = anchor.right + 12;
      top = Math.max(8, Math.min(window.innerHeight - bounds.height - 8, anchor.top));
    } else {
      left = Math.max(8, Math.min(window.innerWidth - bounds.width - 8,
        anchor.left + anchor.width / 2 - bounds.width / 2));
      top = anchor.top - bounds.height - 10;
      if (top < 8) {
        top = anchor.bottom + 10;
      }
    }
    floatingTooltip.style.left = left + "px";
    floatingTooltip.style.top = top + "px";
  }

  function decorateBoardCard(wrapper, card, tr) {
    var statuses = entries(card, tr);
    if (!statuses.length) {
      return;
    }
    statuses.forEach(function (status) {
      wrapper.classList.add("has-" + statusSlug(status.field));
    });
    var labels = statuses.map(function (status) { return status.label; }).join(" · ");
    wrapper.setAttribute("aria-label", wrapper.getAttribute("aria-label") + " · " + labels);
    wrapper.removeAttribute("title");
    var inspect = wrapper.querySelector(".card-inspect");
    if (inspect) {
      inspect.setAttribute("aria-label", inspect.getAttribute("aria-label") + " · " + labels);
    }

    var rail = document.createElement("div");
    rail.className = "keyword-rail";
    rail.setAttribute("aria-hidden", "true");
    var railStatuses = statuses.filter(function (status) { return status.field !== "has_deathrattle"; });
    railStatuses.slice(0, 3).forEach(function (status) {
      var badge = document.createElement("span");
      badge.className = "keyword-icon keyword-icon-" + statusSlug(status.field);
      badge.appendChild(icon(status.icon));
      rail.appendChild(badge);
    });
    if (railStatuses.length > 3) {
      var more = document.createElement("span");
      more.className = "keyword-more";
      more.textContent = "+" + String(railStatuses.length - 3);
      rail.appendChild(more);
    }
    wrapper.appendChild(rail);

    if (card.has_deathrattle === true) {
      var deathrattle = document.createElement("span");
      deathrattle.className = "deathrattle-sigil";
      deathrattle.setAttribute("aria-hidden", "true");
      deathrattle.appendChild(icon("skull"));
      wrapper.appendChild(deathrattle);
    }

    if (card.dormant === true) {
      var dormant = document.createElement("span");
      dormant.className = "dormant-counter";
      dormant.textContent = Number.isFinite(Number(card.dormant_turns))
        ? String(Math.max(0, Number(card.dormant_turns))) : "…";
      dormant.setAttribute("aria-hidden", "true");
      wrapper.appendChild(dormant);
    }

    wrapper.addEventListener("mouseenter", function () {
      showTooltip(wrapper, statuses);
    });
    wrapper.addEventListener("mouseleave", function () { hideTooltip(wrapper); });
    wrapper.addEventListener("focusin", function () { showTooltip(wrapper, statuses); });
    wrapper.addEventListener("focusout", function (event) {
      if (!wrapper.contains(event.relatedTarget)) {
        hideTooltip(wrapper);
      }
    });
  }

  function renderDetails(container, card, tr) {
    container.replaceChildren();
    var statuses = entries(card, tr);
    statuses.forEach(function (status) {
      var chip = document.createElement("span");
      chip.className = "keyword-detail keyword-detail-" + statusSlug(status.field);
      chip.appendChild(icon(status.icon));
      chip.appendChild(document.createTextNode(status.label));
      container.appendChild(chip);
    });
    container.hidden = statuses.length === 0;
  }

  window.FireplaceStatusView = {
    entries: entries,
    decorateBoardCard: decorateBoardCard,
    renderDetails: renderDetails,
    hideTooltip: hideTooltip,
  };
}());
