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
  }));
  assert(metrics.document <= metrics.viewport, `${label}: document overflows horizontally: ${JSON.stringify(metrics)}`);
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
    assert(mulliganState.observation.self.hand.length >= 2, "real opening hand should be visible");
    assert(!Object.hasOwn(mulliganState.observation.opponent, "hand"), "server must omit opponent hand objects");
    const privateOpponentIds = (mulliganState.observation.opponent.hand || []).map((card) => card.card_id);
    assert.equal(privateOpponentIds.length, 0);
    assert.equal(
      await page.locator('[data-testid="hidden-opponent-card"]').count(),
      mulliganState.observation.opponent.hand_count,
      "opponent hand should render backs using only the public count",
    );
    const initialRevisionText = await page.locator('[data-testid="revision"]').innerText();
    await page.locator('[data-testid="hand-card"] [data-testid="card-inspect"]').first().click();
    await page.locator("#card-modal").waitFor({ state: "visible", timeout });
    assert((await page.locator("#modal-card-name").innerText()).trim());
    await page.locator("#modal-close").click();
    await page.locator("#card-modal").waitFor({ state: "hidden", timeout });
    assert.equal(await page.locator('[data-testid="revision"]').innerText(), initialRevisionText);
    assert.equal(seenActions.length, 0, "inspecting a card must not submit a game action");

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

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const mobileMetrics = await assertNoHorizontalOverflow(page, "mobile at MAIN");
    await page.screenshot({ path: path.join(artifacts, "web-gui-mobile.png"), fullPage: true });
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
      await page.locator(`[data-testid="self-board"] [data-entity-id="${boar.entity_id}"].sourceable`).click();
      await page.locator(`[data-testid="opponent-hero"] .targetable[data-entity-id="${attackTarget}"]`).click();
    }, "Charge attack");
    assert.equal(performed.action.type, "ATTACK");
    assert.equal(performed.action.source_entity_id, boar.entity_id);
    assert.equal(performed.action.target_entity_id, attackTarget);
    actions.push(performed.action);

    performed = await clickPositionedMinion(page, "LOE_006", 0, "Museum Curator Discover play");
    assert.equal(performed.action.type, "PLAY_CARD");
    actions.push(performed.action);
    await waitForPhase(page, "选择");

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
      await page.locator('[data-testid="hero-power"] .sourceable[data-entity-id]').click();
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
