#!/usr/bin/env node
/*
 * Reproducible browser acceptance run for the local Fireplace GUI.
 *
 * Example in this checkout:
 *   NODE_PATH=/home/hanqi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules \
 *     FIREPLACE_GUI_PYTHON=/home/hanqi/Desktop/卡牌大对战/fireplace/venv/bin/python \
 *     node tests/web_gui_browser_smoke.cjs
 *
 * A normal Playwright install also works (`npm install playwright` and set
 * CHROME_PATH when Chromium is not installed at /opt/google/chrome/chrome).
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const fixturePath = path.join(__dirname, "web_gui_browser_fixture.py");
const artifacts = process.env.FIREPLACE_GUI_ARTIFACTS || path.join(os.tmpdir(), "fireplace-web-gui-artifacts");
const python = process.env.FIREPLACE_GUI_PYTHON || process.env.PYTHON || "python3";
const chrome = process.env.CHROME_PATH || "/opt/google/chrome/chrome";
const timeout = Number(process.env.FIREPLACE_GUI_TIMEOUT_MS || 20000);

function startFixture() {
  const child = spawn(python, ["-u", fixturePath, "--port", "0"], {
    cwd: root,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const rl = readline.createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture startup timed out\n${logs.join("")}`)), 30000);
    rl.on("line", (line) => {
      logs.push(`${line}\n`);
      try {
        const value = JSON.parse(line);
        if (value && typeof value.url === "string" && Number.isInteger(value.port)) {
          clearTimeout(timer);
          resolve(value);
        }
      } catch (_error) {
        // Fireplace startup diagnostics may precede the fixture's JSON line.
      }
    });
    child.stderr.on("data", (chunk) => logs.push(String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited before ready (code=${code}, signal=${signal})\n${logs.join("")}`));
    });
  });
  return { child, ready, logs };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sameAction(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

async function stateFromPage(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/state", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`GET /api/state failed: ${response.status}`);
    return response.json();
  });
}

async function waitForPhase(page, label) {
  await page.waitForFunction((value) => {
    const node = document.querySelector('[data-testid="phase"]');
    return node && node.textContent.trim() === value;
  }, label, { timeout });
}

async function waitForRevision(page, previous) {
  await page.waitForFunction((value) => {
    const node = document.querySelector('[data-testid="revision"]');
    const match = node && node.textContent.match(/(\d+)/);
    return match && Number(match[1]) > value;
  }, previous, { timeout });
}

function captureActionRequest(page) {
  return page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/action", { timeout });
}

async function performAction(page, before, clickOperation, label) {
  const requestPromise = captureActionRequest(page).then(
    (request) => ({ request }),
    (error) => ({ error }),
  );
  try {
    await clickOperation();
  } catch (error) {
    const debug = await page.evaluate(() => ({
      phase: document.querySelector('[data-testid="phase"]')?.textContent,
      summary: document.querySelector("#selection-summary")?.textContent,
      positions: [...document.querySelectorAll("#position-choices button")].map((button) => ({
        position: button.getAttribute("data-position"), text: button.textContent,
      })),
      targetables: [...document.querySelectorAll(".targetable")].map((node) => node.getAttribute("data-entity-id")),
      submit: {
        hidden: document.querySelector("#action-submit")?.hidden,
        text: document.querySelector("#action-submit")?.textContent,
      },
      notice: document.querySelector("#notice")?.textContent,
    }));
    console.error(`${label}: UI control selection failed; DOM state=${JSON.stringify(debug)}; self_mana=${before.observation.self.mana}/${before.observation.self.max_mana}; hero_power=${JSON.stringify(before.observation.self.hero_power)}; legal_types=${JSON.stringify([...new Set(before.legal_actions.map((action) => action.type))])}; use_power_actions=${JSON.stringify(before.legal_actions.filter((action) => action.type === "USE_HERO_POWER"))}`);
    throw error;
  }
  const captured = await requestPromise;
  if (captured.error) {
    const debug = await page.evaluate(() => ({
      phase: document.querySelector('[data-testid="phase"]')?.textContent,
      summary: document.querySelector("#selection-summary")?.textContent,
      positions: [...document.querySelectorAll("#position-choices button")].map((button) => ({
        position: button.getAttribute("data-position"), text: button.textContent,
      })),
      targetables: [...document.querySelectorAll(".targetable")].map((node) => node.getAttribute("data-entity-id")),
      submit: {
        hidden: document.querySelector("#action-submit")?.hidden,
        text: document.querySelector("#action-submit")?.textContent,
      },
      notice: document.querySelector("#notice")?.textContent,
    }));
    console.error(`${label}: no /api/action request after UI click; DOM state=${JSON.stringify(debug)}; self_mana=${before.observation.self.mana}/${before.observation.self.max_mana}; hero_power=${JSON.stringify(before.observation.self.hero_power)}; legal_types=${JSON.stringify([...new Set(before.legal_actions.map((action) => action.type))])}; use_power_actions=${JSON.stringify(before.legal_actions.filter((action) => action.type === "USE_HERO_POWER"))}`);
    throw captured.error;
  }
  const request = captured.request;
  const body = request.postDataJSON();
  assert.equal(body.revision, before.revision, `${label}: GUI must submit the currently observed revision`);
  assert.equal(body.session_id, before.session_id, `${label}: GUI must submit the current session id`);
  assert(
    before.legal_actions.some((action) => sameAction(action, body.action)),
    `${label}: submitted raw Action is not in the GET /api/state legal_actions list: ${JSON.stringify(body.action)}`,
  );
  const response = await request.response();
  assert(response, `${label}: action request had no response`);
  const payload = await response.json();
  assert.equal(response.status(), 200, `${label}: ${JSON.stringify(payload)}`);
  await waitForRevision(page, before.revision);
  return { action: body.action, state: payload };
}

async function handCard(page, state, cardId, occurrence = 0) {
  const matches = state.observation.self.hand.filter((card) => card.card_id === cardId);
  assert(matches.length > occurrence, `fixture hand has no ${cardId} card #${occurrence + 1}`);
  const card = matches[occurrence];
  return { card, locator: page.locator(`[data-testid="hand-card"][data-entity-id="${card.entity_id}"]`) };
}

async function clickPositionedMinion(page, cardId, position, label) {
  const before = await stateFromPage(page);
  const { card, locator } = await handCard(page, before, cardId);
  const result = await performAction(page, before, async () => {
    await locator.click();
    const button = page.locator(`#position-choices button[data-position="${position}"]`);
    await button.waitFor({ state: "visible", timeout: Math.min(timeout, 2500) });
    await button.click();
  }, label);
  assert.equal(result.action.type, "PLAY_CARD", `${label}: expected PLAY_CARD`);
  assert.equal(result.action.source_entity_id, card.entity_id);
  assert.equal(result.action.position, position, `${label}: chosen insertion position must reach the server`);
  return result;
}

async function clickTargetedHandCard(page, cardId, label) {
  const before = await stateFromPage(page);
  const { card, locator } = await handCard(page, before, cardId);
  const targetId = before.observation.opponent.hero.entity_id;
  const result = await performAction(page, before, async () => {
    await locator.click();
    await page.locator("#target-hint").waitFor({ state: "visible", timeout });
    await page.locator(`[data-testid="opponent-hero"] .targetable[data-entity-id="${targetId}"]`).click();
  }, label);
  assert.equal(result.action.type, "PLAY_CARD");
  assert.equal(result.action.source_entity_id, card.entity_id);
  assert.equal(result.action.target_entity_id, targetId, `${label}: selected target must be serialized`);
  return result;
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    offenders: [...document.querySelectorAll("body *")].map((node) => ({
      name: node.id || node.className?.baseVal || node.className || node.tagName,
      left: Math.round(node.getBoundingClientRect().left),
      right: Math.round(node.getBoundingClientRect().right),
    })).filter((item) => item.right > window.innerWidth + 1 || item.left < -1).slice(0, 12),
  }));
  assert(metrics.document <= metrics.viewport, `${label}: document overflows horizontally: ${JSON.stringify(metrics)}`);
  return metrics;
}

async function assertBoardReadability(page, label) {
  const metrics = await page.evaluate(() => {
    const bounds = (selector) => [...document.querySelectorAll(selector)]
      .map((node) => node.getBoundingClientRect());
    const table = document.querySelector(".table").getBoundingClientRect();
    const opponent = bounds("#opponent-board .board-card, #opponent-board .board-card .stat");
    const own = bounds("#self-board .board-card, #self-board .board-card .stat");
    const hand = bounds("#hand .hand-card");
    const mana = document.querySelector("#mana-value").getBoundingClientRect();
    const heroHealth = document.querySelector("#self-hero-row .stat.health").getBoundingClientRect();
    const powerLabel = document.querySelector("#hero-power-row .power-copy").getBoundingClientRect();
    const overlapping = (left, right) => left.left < right.right && left.right > right.left &&
      left.top < right.bottom && left.bottom > right.top;
    return {
      divider: table.top + table.height * .45,
      opponentBottom: Math.max(...opponent.map((rect) => rect.bottom)),
      ownTop: Math.min(...own.map((rect) => rect.top)),
      handTop: Math.min(...hand.map((rect) => rect.top)),
      manaBottom: mana.bottom,
      heroHealthBottom: heroHealth.bottom,
      healthOverlapsPowerLabel: overlapping(heroHealth, powerLabel),
      boardHealthTexts: [...document.querySelectorAll("#self-board .stat.health strong")]
        .map((node) => node.textContent.trim()),
      fullHealthLabel: document.querySelector("#self-board .stat.health")?.getAttribute("aria-label"),
    };
  });
  assert(metrics.opponentBottom < metrics.divider - 4,
    `${label}: opponent minions cross the scene divider: ${JSON.stringify(metrics)}`);
  assert(metrics.ownTop > metrics.divider + 4,
    `${label}: own minions cross the scene divider: ${JSON.stringify(metrics)}`);
  assert(metrics.manaBottom < metrics.handTop - 2,
    `${label}: hand covers own mana: ${JSON.stringify(metrics)}`);
  assert(metrics.heroHealthBottom < metrics.handTop - 2,
    `${label}: hand covers own hero health: ${JSON.stringify(metrics)}`);
  assert(!metrics.healthOverlapsPowerLabel,
    `${label}: hero health obscures hero power text: ${JSON.stringify(metrics)}`);
  assert(metrics.boardHealthTexts.length && metrics.boardHealthTexts.every((text) => text === "1"),
    `${label}: minion health badge must show one readable number: ${JSON.stringify(metrics)}`);
  assert.match(metrics.fullHealthLabel || "", /生命 1 \/ 1/);
  return metrics;
}

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  const fixture = startFixture();
  let browser;
  try {
    const endpoint = await fixture.ready;
    browser = await chromium.launch({
      headless: process.env.FIREPLACE_GUI_HEADFUL !== "1",
      executablePath: chrome,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    page.on("pageerror", (error) => console.error(`browser page error: ${error.stack || error}`));
    const seenActions = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/action") {
        seenActions.push(request.postDataJSON());
      }
    });

    await page.goto(endpoint.url, { waitUntil: "domcontentloaded" });
    await waitForPhase(page, "换牌");
    const mulliganState = await stateFromPage(page);
    assert.equal(mulliganState.observation.phase, "MULLIGAN");
    assert.equal(await page.locator('[data-testid="quick-action"]').count(), 0, "MAIN buttons should not appear during Mulligan");
    assert(mulliganState.observation.self.hand.length >= 2, "real opening hand should be visible");
    assert(!Object.hasOwn(mulliganState.observation.opponent, "hand"), "server must omit opponent hand objects");
    const privateOpponentIds = (mulliganState.observation.opponent.hand || []).map((card) => card.card_id);
    assert.equal(privateOpponentIds.length, 0);
    assert.equal(
      await page.locator('[data-testid="hidden-opponent-card"]').count(),
      mulliganState.observation.opponent.hand_count,
      "opponent hand should render backs using only the public count",
    );
    await page.screenshot({ path: path.join(artifacts, "web-gui-mulligan.png"), fullPage: true });
    const missingAssetPage = await context.newPage();
    await missingAssetPage.route("**/assets/**", (route) => route.fulfill({
      status: 404, contentType: "application/json", body: '{"error":"missing"}',
    }));
    await missingAssetPage.goto(endpoint.url, { waitUntil: "domcontentloaded" });
    await waitForPhase(missingAssetPage, "换牌");
    await missingAssetPage.locator('[data-testid="hand-card"] .asset-placeholder').first().waitFor({ state: "visible", timeout });
    assert((await missingAssetPage.locator('[data-testid="hand-card"] .card-content').first().innerText()).trim(), "CSS placeholder must retain the card name");
    assert.equal(await missingAssetPage.locator('[data-testid="hand-card"] .card-live-stat-cost').first().innerText(), "0",
      "CSS placeholder must show the current mana cost");
    assert.equal(await missingAssetPage.locator('[data-testid="hand-card"] .card-live-stat-attack').first().innerText(), "1");
    assert.equal(await missingAssetPage.locator('[data-testid="hand-card"] .card-live-stat-health').first().innerText(), "1");
    await missingAssetPage.close();
    const initialRevisionText = await page.locator('[data-testid="revision"]').innerText();
    await page.locator('[data-testid="hand-card"] [data-testid="card-inspect"]').first().click();
    await page.locator("#card-modal").waitFor({ state: "visible", timeout });
    assert((await page.locator("#modal-card-name").innerText()).trim());
    await page.locator("#modal-close").click();
    await page.locator("#card-modal").waitFor({ state: "hidden", timeout });
    await page.locator('[data-testid="hand-card"] [data-testid="card-inspect"]').first().focus();
    await page.keyboard.press("Enter");
    await page.locator("#card-modal").waitFor({ state: "visible", timeout });
    await page.locator("#modal-close").click();
    await page.locator("#card-modal").waitFor({ state: "hidden", timeout });
    assert.equal(await page.locator('[data-testid="revision"]').innerText(), initialRevisionText);
    assert.equal(seenActions.length, 0, "mouse and keyboard inspection must not submit a game action");

    // A second page keeps the old snapshot so a real stale click can exercise
    // the server's 409 + refreshed-snapshot path without a synthetic POST.
    const stalePage = await context.newPage();
    stalePage.setDefaultTimeout(timeout);
    await stalePage.goto(endpoint.url, { waitUntil: "domcontentloaded" });
    await waitForPhase(stalePage, "换牌");
    const staleState = await stateFromPage(stalePage);
    const staleId = staleState.observation.self.hand[1].entity_id;
    await stalePage.locator(`[data-testid="hand-card"][data-entity-id="${staleId}"]`).click();
    await stalePage.route("**/api/state", (route) => route.abort());

    const mulliganId = mulliganState.observation.self.hand[0].entity_id;
    const mulliganResult = await performAction(page, mulliganState, async () => {
      await page.locator(`[data-testid="hand-card"][data-entity-id="${mulliganId}"]`).click();
      await page.locator('[data-testid="action-submit"]').click();
    }, "Mulligan replacement");
    assert.equal(mulliganResult.action.type, "MULLIGAN");
    assert(mulliganResult.action.mulligan_entity_ids.includes(mulliganId));
    await waitForPhase(page, "主阶段");

    const staleRequestPromise = captureActionRequest(stalePage);
    await stalePage.locator('[data-testid="action-submit"]').click();
    const staleRequest = await staleRequestPromise;
    const stalePost = staleRequest.postDataJSON();
    assert.equal(stalePost.revision, staleState.revision);
    assert.equal(stalePost.session_id, staleState.session_id);
    assert(staleState.legal_actions.some((action) => sameAction(action, stalePost.action)));
    const staleResponse = await staleRequest.response();
    assert.equal(staleResponse.status(), 409);
    await stalePage.locator("#notice").waitFor({ state: "visible", timeout });
    assert.match(await stalePage.locator("#notice").innerText(), /动作已过期/);

    let state = await stateFromPage(page);
    assert.equal(state.observation.phase, "MAIN");
    assert.equal(await page.locator("#pending-choice").evaluate((node) => node.hidden), true);
    for (const type of ["PLAY_CARD", "ATTACK", "USE_HERO_POWER"]) {
      const expected = new Set(state.legal_actions.filter((action) => action.type === type).map((action) => action.source_entity_id)).size;
      assert.equal(await page.locator(`[data-testid="quick-action"][data-action-type="${type}"]`).count(), expected, `${type}: one visible button per legal source`);
    }
    const backupPosition = await page.evaluate(() => ({
      boardBottom: document.querySelector(".table").getBoundingClientRect().bottom,
      quickTop: document.querySelector("#quick-actions").getBoundingClientRect().top,
      fallbackTop: document.querySelector("#action-fallback").getBoundingClientRect().top,
    }));
    assert(backupPosition.quickTop >= backupPosition.boardBottom - 1, `quick actions should be below the board: ${JSON.stringify(backupPosition)}`);
    assert(backupPosition.fallbackTop >= backupPosition.boardBottom - 1, `raw actions should be below the board: ${JSON.stringify(backupPosition)}`);
    await assertNoHorizontalOverflow(page, "desktop at MAIN");
    const thinDecisionRects = await page.locator("#decision-panel").evaluate((rootNode) =>
      [...rootNode.querySelectorAll("*")].map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          node: node.id || node.className || node.tagName.toLowerCase(),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          display: style.display,
          hidden: node.hidden,
        };
      }).filter((item) => item.width > 600 && item.height > 0 && item.height <= 28 && item.display !== "none" && !item.hidden),
    );
    await page.screenshot({ path: path.join(artifacts, "web-gui-desktop.png"), fullPage: true });

    for (const viewport of [{ width: 1280, height: 720 }, { width: 1680, height: 928 }]) {
      await page.setViewportSize(viewport);
      await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} at MAIN`);
      assert(await page.locator('[data-testid="hero-power"] .power-card').isVisible(), "hero power remains visible");
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const mobileMetrics = await assertNoHorizontalOverflow(page, "mobile at MAIN");
    await page.screenshot({ path: path.join(artifacts, "web-gui-mobile.png"), fullPage: true });
    await page.locator('[data-testid="hand-card"] [data-testid="card-inspect"]').first().click();
    await page.locator("#card-modal").waitFor({ state: "visible", timeout });
    const mobileCardDetail = await page.locator("#card-modal .card-modal-dialog").boundingBox();
    assert(mobileCardDetail && mobileCardDetail.width <= 390,
      "narrow-screen inspect must reveal a complete card without horizontal clipping");
    await page.locator("#modal-close").click();
    await page.setViewportSize({ width: 1440, height: 1000 });

    const actions = [];
    let performed = await clickPositionedMinion(page, "CS2_231", 0, "play Wisp in first slot");
    actions.push(performed.action);
    performed = await clickPositionedMinion(page, "CS2_171", 1, "play Charge minion in second slot");
    actions.push(performed.action);

    state = await stateFromPage(page);
    const boar = state.observation.self.board.find((card) => card.card_id === "CS2_171");
    assert(boar, "Stonetusk Boar should be on board");
    const attackTarget = state.observation.opponent.hero.entity_id;
    performed = await performAction(page, state, async () => {
      await page.locator(`[data-testid="self-board"] .board-card[data-entity-id="${boar.entity_id}"]`).click();
      const target = page.locator(`[data-testid="opponent-hero"] .targetable[data-entity-id="${attackTarget}"]`);
      await target.hover();
      assert.equal(await page.locator(".attack-line").evaluate((node) => node.hidden), false, "attack line should track the legal target");
      await target.click();
    }, "Charge attack");
    assert.equal(performed.action.type, "ATTACK");
    assert.equal(performed.action.source_entity_id, boar.entity_id);
    assert.equal(performed.action.target_entity_id, attackTarget);
    actions.push(performed.action);

    performed = await clickPositionedMinion(page, "LOE_006", 0, "Museum Curator Discover play");
    assert.equal(performed.action.type, "PLAY_CARD");
    actions.push(performed.action);
    await waitForPhase(page, "选择");
    assert.equal(await page.locator('[data-testid="quick-action"]').count(), 0, "MAIN buttons should not appear during Discover");
    await page.screenshot({ path: path.join(artifacts, "web-gui-discover.png"), fullPage: true });

    state = await stateFromPage(page);
    assert(state.legal_actions.every((action) => action.type === "CHOOSE"));
    performed = await performAction(page, state, async () => {
      await page.locator('[data-testid="choice-options"] [role="button"]').first().click();
    }, "Discover choice");
    assert.equal(performed.action.type, "CHOOSE");
    actions.push(performed.action);
    await waitForPhase(page, "主阶段");

    state = await stateFromPage(page);
    const powerTarget = state.observation.opponent.hero.entity_id;
    performed = await performAction(page, state, async () => {
      await page.locator('[data-testid="hero-power"] .power-card').click();
      await page.locator(`[data-testid="opponent-hero"] .targetable[data-entity-id="${powerTarget}"]`).click();
    }, "targeted Hero Power");
    assert.equal(performed.action.type, "USE_HERO_POWER");
    assert.equal(performed.action.target_entity_id, powerTarget);
    actions.push(performed.action);

    state = await stateFromPage(page);
    const nourish = await handCard(page, state, "EX1_164");
    performed = await performAction(page, state, async () => {
      await nourish.locator.click();
      await page.locator('#choice-options [role="button"]').first().waitFor({ state: "visible", timeout });
      await page.locator('#choice-options [role="button"]').first().click();
    }, "Nourish choose-one branch");
    assert.equal(performed.action.type, "PLAY_CARD");
    assert(performed.action.choose_option_entity_id, "Nourish branch id should be in raw Action");
    actions.push(performed.action);

    state = await stateFromPage(page);
    performed = await clickTargetedHandCard(page, "CS2_029", "targeted lethal Fireball");
    actions.push(performed.action);
    await waitForPhase(page, "对局结束");
    await page.locator('[data-testid="game-over"]').waitFor({ state: "visible", timeout });
    state = await stateFromPage(page);
    assert.equal(state.observation.phase, "GAME_OVER");
    assert.equal(await page.locator('[data-testid="quick-action"]').count(), 0, "MAIN buttons should not appear after Game Over");
    assert(state.outcome && state.outcome.winner);
    assert.deepEqual(new Set(actions.map((action) => action.type)), new Set([
      "PLAY_CARD", "ATTACK", "CHOOSE", "USE_HERO_POWER",
    ]));
    assert(actions.filter((action) => action.type === "PLAY_CARD" && action.position !== undefined).length >= 2);
    assert(actions.some((action) => action.type === "PLAY_CARD" && action.target_entity_id !== undefined));
    assert(actions.some((action) => action.type === "PLAY_CARD" && action.choose_option_entity_id !== undefined));
    assert(seenActions.every((entry) => typeof entry.session_id === "string" && Number.isInteger(entry.revision) && entry.action));
    await page.screenshot({ path: path.join(artifacts, "web-gui-game-over.png"), fullPage: true });
    await page.locator("#game-over-dismiss").click();
    await page.locator('[data-testid="game-over"]').waitFor({ state: "hidden", timeout });

    // Mock only the read endpoint for one new page to cover public extras and
    // Game Over presentation without inventing any opponent card identity.
    const mock = JSON.parse(JSON.stringify(state));
    mock.revision += 100;
    mock.observation.self.weapon = {
      entity_id: 90001, card_id: "CS2_080", name: "测试武器", atk: 3, durability: 2,
    };
    mock.observation.self.secrets = [
      { entity_id: 90002, card_id: "EX1_611", name: "测试奥秘" },
    ];
    mock.observation.opponent.secrets_count = 2;
    mock.observation.opponent.hero_power = {
      entity_id: 90003, card_id: "CS2_083b", name: "火焰冲击", cost: 2, is_usable: false,
    };
    mock.observation.opponent.hand_count = 3;
    delete mock.observation.opponent.hand;
    mock.legal_actions = [];
    mock.observation.phase = "GAME_OVER";
    mock.outcome = { winner: "Mock Human", human_won: true };
    const privateMarker = "HIDDEN_OPPONENT_PRIVATE_CARD_ID";
    assert(!JSON.stringify(mock.observation.opponent).includes(privateMarker));

    const mockPage = await context.newPage();
    mockPage.setDefaultTimeout(timeout);
    await mockPage.route("**/api/state", (route) => route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(mock),
    }));
    await mockPage.goto(endpoint.url, { waitUntil: "domcontentloaded" });
    await waitForPhase(mockPage, "对局结束");
    assert.match(await mockPage.locator('[data-testid="self-weapon"]').innerText(), /测试武器/);
    assert.match(await mockPage.locator('[data-testid="self-secret"]').innerText(), /测试奥秘/);
    assert.match(await mockPage.locator('[data-testid="opponent-secret-count"]').innerText(), /×2/);
    assert.match(await mockPage.locator('[data-testid="opponent-hero"]').innerText(), /火焰冲击/);
    assert.equal(await mockPage.locator('[data-testid="hidden-opponent-card"]').count(), 3);
    assert(!await mockPage.locator("body").innerText().then((text) => text.includes(privateMarker)));
    await mockPage.locator("#game-over-dismiss").click();
    await mockPage.locator('[data-testid="game-over"]').waitFor({ state: "hidden", timeout });
    await mockPage.screenshot({ path: path.join(artifacts, "web-gui-mocked-extras.png"), fullPage: true });

    // Isolate visual hand states at the JSON boundary.  The Python snapshot
    // test checks the real engine values; this checks their browser treatment.
    const visual = JSON.parse(JSON.stringify(mulliganState));
    visual.revision += 150;
    visual.observation.phase = "MAIN";
    visual.observation.self.mana = 5;
    visual.observation.self.max_mana = 5;
    const baseHand = visual.observation.self.hand[0];
    const spellHand = { ...baseHand, entity_id: 91502, card_id: "CS2_029", name: "Fireball",
      cost: 2, printed_cost: 4, powered_up: false };
    for (const field of ["atk", "printed_atk", "health", "max_health", "printed_health",
      "durability", "printed_durability"]) delete spellHand[field];
    visual.observation.self.hand = [
      { ...baseHand, entity_id: 91501, cost: 3, printed_cost: 2, atk: 4, printed_atk: 3,
        max_health: 1, printed_health: 2, powered_up: true },
      spellHand,
      { ...baseHand, entity_id: 91503, cost: 6, printed_cost: 5, atk: 1, printed_atk: 2,
        max_health: 1, printed_health: 2, powered_up: true },
    ];
    visual.observation.self.board = [
      { entity_id: 91511, card_id: "CS2_231", name: "词条测试随从", atk: 3, health: 4,
        max_health: 4, taunt: true, divine_shield: true, poisonous: true,
        has_deathrattle: true, lifesteal: true },
      { entity_id: 91512, card_id: "CS2_231", name: "休眠测试随从", atk: 2, health: 2,
        max_health: 2, dormant: true, dormant_turns: 2 },
    ];
    visual.observation.opponent.board = [
      { entity_id: 91513, card_id: "CS2_231", name: "冰冻测试随从", atk: 1, health: 1,
        max_health: 1, frozen: true, stealthed: true },
    ];
    visual.legal_actions = [
      { schema_version: 1, type: "PLAY_CARD", source_entity_id: 91501, position: 0 },
      { schema_version: 1, type: "PLAY_CARD", source_entity_id: 91502,
        target_entity_id: visual.observation.opponent.hero.entity_id },
      { schema_version: 1, type: "END_TURN" },
    ];
    visual.events = [];
    visual.outcome = null;
    const visualPage = await context.newPage();
    await visualPage.route("**/api/state", (route) => route.fulfill({
      status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(visual),
    }));
    await visualPage.goto(endpoint.url, { waitUntil: "domcontentloaded" });
    await waitForPhase(visualPage, "主阶段");
    const activeHand = visualPage.locator('[data-testid="hand-card"][data-entity-id="91501"]');
    const cheaperHand = visualPage.locator('[data-testid="hand-card"][data-entity-id="91502"]');
    const blockedHand = visualPage.locator('[data-testid="hand-card"][data-entity-id="91503"]');
    assert(await activeHand.evaluate((node) => node.classList.contains("playable") && node.classList.contains("powered-up")),
      "a legal powered-up card must have the yellow state");
    assert(await cheaperHand.evaluate((node) => node.classList.contains("playable") && !node.classList.contains("powered-up")),
      "a legal card without its extra condition must have the green state");
    assert(await blockedHand.evaluate((node) => !node.classList.contains("playable") && !node.classList.contains("powered-up")),
      "an unplayable card must not glow even when its condition is met");
    assert.equal(await activeHand.locator(".card-live-stat-cost.cost-higher").innerText(), "3");
    assert.equal(await activeHand.locator(".card-live-stat-attack.stat-higher").innerText(), "4");
    assert.equal(await activeHand.locator(".card-live-stat-health.stat-lower").innerText(), "1");
    assert.equal(await cheaperHand.locator(".card-live-stat-cost.cost-lower").innerText(), "2");
    assert.equal(await cheaperHand.locator(".card-live-stat-attack, .card-live-stat-health").count(), 0,
      "a spell should not show minion stats");
    assert.equal(await blockedHand.locator(".card-live-stat-cost.cost-higher").innerText(), "6");
    assert.equal(await blockedHand.locator(".card-live-stat-attack.stat-lower").innerText(), "1");
    assert.match(await activeHand.getAttribute("aria-label"), /费用 3.*攻击 4.*生命 1/);
    const visualColors = await visualPage.evaluate(() => {
      const css = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      return {
        poweredGlow: css('[data-entity-id="91501"]', "filter"),
        playableGlow: css('[data-entity-id="91502"]', "filter"),
        increasedCost: css('[data-entity-id="91501"] .card-live-stat-cost', "color"),
        increasedAttack: css('[data-entity-id="91501"] .card-live-stat-attack', "color"),
        decreasedHealth: css('[data-entity-id="91501"] .card-live-stat-health', "color"),
        reducedCost: css('[data-entity-id="91502"] .card-live-stat-cost', "color"),
      };
    });
    assert.match(visualColors.poweredGlow, /244, 186, 89/, "powered-up glow should be yellow");
    assert.match(visualColors.playableGlow, /120, 219, 116/, "ordinary playable glow should be green");
    assert.equal(visualColors.increasedCost, "rgb(255, 143, 124)");
    assert.equal(visualColors.increasedAttack, "rgb(161, 239, 168)");
    assert.equal(visualColors.decreasedHealth, "rgb(255, 255, 255)");
    assert.equal(visualColors.reducedCost, "rgb(161, 239, 168)");
    const keywordMinion = visualPage.locator('#self-board .board-card[data-entity-id="91511"]');
    const dormantMinion = visualPage.locator('#self-board .board-card[data-entity-id="91512"]');
    assert(await keywordMinion.evaluate((node) => node.classList.contains("has-taunt") &&
      node.classList.contains("has-divine-shield") && node.classList.contains("has-poisonous")));
    assert.equal(await keywordMinion.locator(".keyword-icon").count(), 3);
    assert.equal(await keywordMinion.locator(".keyword-more").innerText(), "+1");
    assert(await keywordMinion.evaluate((node) => node.classList.contains("has-deathrattle")));
    assert.equal(await keywordMinion.locator(".deathrattle-sigil svg").count(), 1,
      "deathrattle must have its own visible mark even when other keywords overflow");
    assert.equal(await keywordMinion.getAttribute("title"), null,
      "custom keyword tooltip should not compete with the browser title tooltip");
    assert.match(await keywordMinion.getAttribute("aria-label"), /嘲讽.*圣盾.*剧毒.*亡语.*吸血/);
    assert.equal(await dormantMinion.locator(".dormant-counter").innerText(), "2");
    assert.match(await dormantMinion.getAttribute("aria-label"), /休眠.*剩余 2 回合/);
    assert(await visualPage.locator('#opponent-board .board-card[data-entity-id="91513"]')
      .evaluate((node) => node.classList.contains("has-frozen") && node.classList.contains("has-stealthed")));
    await keywordMinion.hover();
    await visualPage.locator(".keyword-tooltip").waitFor({ state: "visible", timeout });
    await visualPage.waitForTimeout(180);
    await visualPage.screenshot({ path: path.join(artifacts, "web-gui-board-keywords-hover.png"), fullPage: true });
    await keywordMinion.locator('[data-testid="card-inspect"]').click();
    await visualPage.locator("#card-modal").waitFor({ state: "visible", timeout });
    assert.match(await visualPage.locator("#modal-statuses").innerText(), /嘲讽.*圣盾.*剧毒.*亡语.*吸血/s);
    await visualPage.locator("#modal-close").click();
    await dormantMinion.locator('[data-testid="card-inspect"]').click();
    assert.match(await visualPage.locator("#modal-statuses").innerText(), /休眠.*剩余 2 回合/);
    await visualPage.locator("#modal-close").click();
    await activeHand.locator('[data-testid="card-inspect"]').focus();
    await visualPage.keyboard.press("Enter");
    await visualPage.locator("#card-modal").waitFor({ state: "visible", timeout });
    assert.equal(await visualPage.locator("#modal-art .card-live-stat-cost.cost-higher").innerText(), "3");
    assert.equal(await visualPage.locator("#modal-art .card-live-stat-attack.stat-higher").innerText(), "4");
    assert.equal(await visualPage.locator("#modal-art .card-live-stat-health.stat-lower").innerText(), "1");
    assert.equal(await visualPage.locator("#modal-stats .stat.health strong").innerText(), "1");
    await visualPage.screenshot({ path: path.join(artifacts, "web-gui-hand-live-stats-modal.png"), fullPage: true });
    await visualPage.locator("#modal-close").click();
    await visualPage.screenshot({ path: path.join(artifacts, "web-gui-hand-live-stats.png"), fullPage: true });
    await visualPage.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalOverflow(visualPage, "mobile hand live stats");
    assert.equal(await dormantMinion.locator(".dormant-counter").innerText(), "2");
    assert(await keywordMinion.locator(".stat.health strong").isVisible(),
      "keyword layer must leave the minion health visible on mobile");
    const deathrattleGeometry = await keywordMinion.evaluate((node) => {
      const sigil = node.querySelector(".deathrattle-sigil").getBoundingClientRect();
      return [...node.querySelectorAll(".stat.attack, .stat.health, .keyword-more")].map((stat) => {
        const rect = stat.getBoundingClientRect();
        return sigil.left < rect.right && sigil.right > rect.left &&
          sigil.top < rect.bottom && sigil.bottom > rect.top;
      });
    });
    assert(deathrattleGeometry.every((overlap) => !overlap),
      "deathrattle mark must not cover mobile combat stats or other keyword badges");
    const mobileKeywordGeometry = await keywordMinion.evaluate((node) => {
      const more = node.querySelector(".keyword-more").getBoundingClientRect();
      const attack = node.querySelector(".stat.attack").getBoundingClientRect();
      const health = node.querySelector(".stat.health").getBoundingClientRect();
      return {
        more: { left: more.left, right: more.right, top: more.top, bottom: more.bottom },
        attack: { left: attack.left, right: attack.right, top: attack.top, bottom: attack.bottom },
        health: { left: health.left, right: health.right, top: health.top, bottom: health.bottom },
        overlap: [attack, health].some((stat) => more.left < stat.right && more.right > stat.left &&
          more.top < stat.bottom && more.bottom > stat.top),
      };
    });
    assert(!mobileKeywordGeometry.overlap,
      `keyword overflow indicator must not cover combat stats: ${JSON.stringify(mobileKeywordGeometry)}`);
    await visualPage.screenshot({ path: path.join(artifacts, "web-gui-hand-live-stats-mobile.png"), fullPage: true });
    visual.locale = "enUS";
    await visualPage.evaluate(() => localStorage.setItem("fireplace.locale", "enUS"));
    await visualPage.reload({ waitUntil: "domcontentloaded" });
    await dormantMinion.waitFor({ state: "visible", timeout });
    assert.match(await dormantMinion.getAttribute("aria-label"), /Dormant.*2 turns left/);
    assert.match(await keywordMinion.getAttribute("aria-label"), /Taunt.*Divine shield.*Poisonous.*Deathrattle.*Lifesteal/);
    await dormantMinion.locator('[data-testid="card-inspect"]').click();
    assert.match(await visualPage.locator("#modal-statuses").innerText(), /Dormant.*2 turns left/);
    visual.revision += 1;
    visual.observation.self.board[1].dormant = false;
    delete visual.observation.self.board[1].dormant_turns;
    await visualPage.evaluate(() => window.fireplaceWebGui.loadState(true));
    assert(!await dormantMinion.evaluate((node) => node.classList.contains("has-dormant")));
    assert.equal(await dormantMinion.locator(".dormant-counter").count(), 0);
    assert(await visualPage.locator("#modal-statuses").evaluate((node) => node.hidden),
      "open details must drop dormant state when the next snapshot wakes the minion");
    await visualPage.locator("#modal-close").click();
    await keywordMinion.locator('[data-testid="card-inspect"]').click();
    assert.match(await visualPage.locator("#modal-statuses").innerText(), /Deathrattle/);
    visual.revision += 1;
    visual.observation.self.board[0].has_deathrattle = false;
    await visualPage.evaluate(() => window.fireplaceWebGui.loadState(true));
    assert.equal(await keywordMinion.locator(".deathrattle-sigil").count(), 0);
    assert(!await visualPage.locator("#modal-statuses").innerText().then((value) => value.includes("Deathrattle")),
      "open details must drop deathrattle after the next public snapshot removes it");
    await visualPage.locator("#modal-close").click();
    await visualPage.close();

    // Near board capacity, every legal insertion slot must remain reachable
    // on a narrow screen.  Mock only the JSON boundary, then inspect and
    // click the same raw Action the regular UI would send.
    const crowded = JSON.parse(JSON.stringify(mulliganState));
    crowded.revision += 200;
    crowded.observation.phase = "MAIN";
    crowded.observation.self.mana = 10;
    crowded.observation.self.max_mana = 10;
    crowded.observation.self.board = Array.from({ length: 6 }, (_, index) => ({
      ...mulliganState.observation.self.hand[0], entity_id: 91000 + index,
      atk: 1, health: 1, max_health: 1, can_attack: false,
    }));
    crowded.observation.self.board[0].taunt = true;
    crowded.observation.self.board[0].poisonous = true;
    crowded.observation.opponent.board = Array.from({ length: 6 }, (_, index) => ({
      ...mulliganState.observation.self.hand[0], entity_id: 91100 + index,
      atk: 1, health: 1, max_health: 1, can_attack: false,
    }));
    crowded.observation.self.hand = Array.from({ length: 10 }, (_, index) => ({
      ...mulliganState.observation.self.hand[0], entity_id: 91020 + index,
    }));
    crowded.legal_actions = Array.from({ length: 7 }, (_, position) => ({
      schema_version: 1, type: "PLAY_CARD", source_entity_id: 91020, position,
    }));
    crowded.outcome = null;
    crowded.events = [];
    let crowdedPost = null;
    const crowdedPage = await context.newPage();
    await crowdedPage.setViewportSize({ width: 390, height: 844 });
    await crowdedPage.route("**/assets/**", (route) => route.fulfill({ status: 404, body: "" }));
    await crowdedPage.route("**/api/state", (route) => route.fulfill({
      status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(crowded),
    }));
    await crowdedPage.route("**/api/action", (route) => {
      crowdedPost = route.request().postDataJSON();
      const after = JSON.parse(JSON.stringify(crowded));
      after.revision += 1;
      after.observation.self.board.push(after.observation.self.hand.shift());
      after.legal_actions = [];
      route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(after) });
    });
    await crowdedPage.goto(endpoint.url, { waitUntil: "domcontentloaded" });
    await waitForPhase(crowdedPage, "主阶段");
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 },
      { width: 1440, height: 900 }, { width: 1680, height: 928 }]) {
      await crowdedPage.setViewportSize(viewport);
      await assertBoardReadability(crowdedPage, `${viewport.width}x${viewport.height} crowded board`);
    }
    await crowdedPage.screenshot({ path: path.join(artifacts, "web-gui-desktop-crowded-board.png"), fullPage: true });
    await crowdedPage.setViewportSize({ width: 390, height: 844 });
    const firstCrowdedMinion = crowdedPage.locator('#self-board .board-card[data-entity-id="91000"]');
    await firstCrowdedMinion.hover();
    await crowdedPage.locator(".keyword-tooltip").waitFor({ state: "visible", timeout });
    const keywordBounds = await crowdedPage.evaluate(() => {
      const tooltip = document.querySelector(".keyword-tooltip").getBoundingClientRect();
      const rail = document.querySelector('#self-board .board-card[data-entity-id="91000"] .keyword-rail').getBoundingClientRect();
      const board = document.querySelector("#self-board").getBoundingClientRect();
      return { tooltipLeft: tooltip.left, tooltipRight: tooltip.right, tooltipTop: tooltip.top,
        tooltipBottom: tooltip.bottom, railLeft: rail.left, boardLeft: board.left, viewport: innerWidth };
    });
    assert(keywordBounds.tooltipLeft >= 0 && keywordBounds.tooltipRight <= keywordBounds.viewport &&
      keywordBounds.tooltipTop >= 0 && keywordBounds.tooltipBottom <= 844,
    `mobile keyword tooltip must stay in viewport: ${JSON.stringify(keywordBounds)}`);
    assert(keywordBounds.railLeft >= keywordBounds.boardLeft - 1,
      `first minion keyword icons must not be clipped by scroller: ${JSON.stringify(keywordBounds)}`);
    await crowdedPage.screenshot({ path: path.join(artifacts, "web-gui-mobile-crowded-keywords.png") });
    await crowdedPage.locator('[data-testid="hand-card"][data-entity-id="91020"]').click();
    assert.equal(await crowdedPage.locator("#self-board .board-slot").count(), 7);
    for (let position = 0; position <= 6; position += 1) {
      const slot = crowdedPage.locator(`#self-board .board-slot[data-position="${position}"]`);
      await slot.scrollIntoViewIfNeeded();
      const reachable = await slot.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          ok: x >= 0 && x <= innerWidth && hit && (hit === node || node.contains(hit)),
          x, y, width: rect.width, height: rect.height,
          hit: hit && (hit.id || hit.className || hit.tagName),
          scrollLeft: node.parentElement.scrollLeft,
        };
      });
      assert(reachable.ok, `mobile insertion slot ${position} is not clickable: ${JSON.stringify(reachable)}`);
    }
    await crowdedPage.screenshot({ path: path.join(artifacts, "web-gui-mobile-crowded-board.png"), fullPage: true });
    await crowdedPage.locator('#self-board .board-slot[data-position="6"]').click();
    assert(crowdedPost && sameAction(crowdedPost.action, crowded.legal_actions[6]), "last mobile slot must submit its original legal Action");
    await crowdedPage.close();

    console.log(JSON.stringify({
      result: "PASS",
      url: endpoint.url,
      actions: seenActions.map((entry) => ({ revision: entry.revision, type: entry.action.type, ...entry.action })),
      staleStatus: staleResponse.status(),
      desktopViewport: { width: 1440, height: 1000 },
      mobileViewport: mobileMetrics,
      thinDecisionRects,
      artifacts,
    }, null, 2));
    await context.close();
  } finally {
    if (browser) await browser.close();
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => fixture.child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
        fixture.child.kill("SIGKILL");
      }
    }
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
