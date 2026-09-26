#!/usr/bin/env node
/* Real-draft, multi-turn browser acceptance for Random and Heuristic AI. */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const python = process.env.FIREPLACE_GUI_PYTHON || process.env.PYTHON || "python3";
const chrome = process.env.CHROME_PATH || "/opt/google/chrome/chrome";
const artifacts = process.env.FIREPLACE_GUI_ARTIFACTS || path.join(os.tmpdir(), "fireplace-web-gui-artifacts");

function startServer() {
  const child = spawn(python, ["-u", "-m", "fireplace.web_gui", "--seed", "2", "--opponent", "random", "--port", "0"], {
    cwd: root, env: { ...process.env, PYTHONUNBUFFERED: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = [];
  const remember = (line) => { tail.push(line); if (tail.length > 80) tail.shift(); };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => remember(String(chunk)));
  const lines = readline.createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${tail.join("")}`)), 30000);
    lines.on("line", (line) => {
      remember(line);
      const match = line.match(/Open (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${tail.join("")}`)); });
  });
  return { child, ready, tail };
}

function chooseAction(state) {
  const actions = state.legal_actions;
  assert(actions.length, `no legal actions in ${state.observation.phase}`);
  if (state.observation.phase === "MULLIGAN") {
    return actions.find((action) => action.type === "MULLIGAN" && !action.mulligan_entity_ids.length) || actions[0];
  }
  if (state.observation.phase === "CHOICE") return actions[0];
  const enemyHero = state.observation.opponent.hero.entity_id;
  return actions.find((action) => action.type === "ATTACK" && action.target_entity_id === enemyHero)
    || actions.find((action) => action.type === "PLAY_CARD")
    || actions.find((action) => action.type === "USE_HERO_POWER" && action.target_entity_id === enemyHero)
    || actions.find((action) => action.type === "END_TURN")
    || actions[0];
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function clickAction(page, action, actionKey) {
  if (action.type === "END_TURN") {
    await page.locator("#end-turn-button").click();
    return "end-turn";
  }
  if ((action.type === "PLAY_CARD" || action.type === "ATTACK" || action.type === "USE_HERO_POWER") &&
      action.choose_option_entity_id === undefined) {
    const sourceSelector = action.type === "PLAY_CARD"
      ? `#hand .hand-card[data-entity-id="${action.source_entity_id}"]`
      : action.type === "USE_HERO_POWER"
        ? `#hero-power-row .power-card[data-entity-id="${action.source_entity_id}"]`
        : `.sourceable[data-entity-id="${action.source_entity_id}"]`;
    const source = page.locator(sourceSelector);
    if (await source.count()) {
      await source.click();
      if (action.position !== undefined) {
        await page.locator(`#self-board .board-slot[data-position="${action.position}"]`).click();
      }
      if (action.target_entity_id !== undefined) {
        await page.locator(`.targetable[data-entity-id="${action.target_entity_id}"]`).click();
      }
      return "direct";
    }
  }
  const fallback = page.locator("#action-fallback");
  if (!(await fallback.evaluate((node) => node.open))) await fallback.locator("summary").click();
  const index = await page.locator("#action-menu .action-button").evaluateAll(
    (buttons, key) => buttons.findIndex((button) => button.getAttribute("data-action-key") === key), actionKey,
  );
  assert(index >= 0, `raw action missing from GUI: ${actionKey}`);
  await page.locator("#action-menu .action-button").nth(index).click();
  return "fallback";
}

async function assertOpponentHidden(page, state, label) {
  assert(!Object.hasOwn(state.observation.opponent, "hand"), `${label}: opponent hand leaked to browser`);
  const expectedCount = state.observation.opponent.hand_count;
  assert(Number.isInteger(expectedCount) && expectedCount >= 0, `${label}: missing public opponent hand count`);
  await page.waitForFunction((count) =>
    document.querySelectorAll('[data-testid="hidden-opponent-card"]').length === count,
  expectedCount, { timeout: 60000 });
  const backs = await page.locator('[data-testid="hidden-opponent-card"]').evaluateAll((nodes) => nodes.map((node) => ({
    text: node.textContent,
    entityId: node.getAttribute("data-entity-id"),
    cardId: node.getAttribute("data-card-id"),
  })));
  assert.equal(backs.length, expectedCount, `${label}: rendered hand backs must match the public count`);
  assert(backs.every((card) => !card.text && card.entityId === null && card.cardId === null),
    `${label}: opponent hand backs must not carry card identities`);
}

async function startMatchFromLobby(page, { policy, locale, nickname }) {
  await page.locator("#lobby-screen").waitFor({ state: "visible" });
  await page.locator(`#locale-${locale}`).click();
  await page.locator("#nickname-input").fill(nickname);
  const enterLobby = page.locator("#enter-lobby-button");
  if (await enterLobby.isVisible()) {
    assert.equal(await enterLobby.innerText(), locale === "enUS" ? "Enter lobby" : "进入大厅");
    await enterLobby.click();
  }
  await page.locator("#lobby-setup").waitFor({ state: "visible", timeout: 60000 });
  await page.locator(`input[name="opponent"][value="${policy}"]`).check();

  const requestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/start", { timeout: 60000 });
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/start", { timeout: 60000 });
  await page.locator("#start-match-button").click();
  const [request, response] = await Promise.all([requestPromise, responsePromise]);
  const requestBody = request.postDataJSON();
  assert.deepEqual(requestBody, { nickname, opponent: policy, locale }, "lobby controls must reach the start API");
  const state = await response.json();
  assert.equal(response.status(), 200, `${policy}/${locale}: start failed: ${JSON.stringify(state)}`);
  assert.equal(state.mode, "match");
  assert.equal(state.locale, locale, "server must lock the selected language for the match");
  assert.equal(state.nickname, nickname);

  await page.waitForFunction(() =>
    document.querySelector("#lobby-screen").hidden && !document.querySelector("#game").hidden,
  null, { timeout: 60000 });
  await page.waitForFunction(() => /\d+/.test(document.querySelector('[data-testid="revision"]')?.textContent || ""),
    null, { timeout: 60000 });
  assert.equal(await page.locator("html").getAttribute("lang"), locale === "enUS" ? "en" : "zh-CN");
  assert.equal(await page.locator("#hand-title").innerText(), locale === "enUS" ? "Your hand" : "你的手牌");
  assert.equal(await page.locator("#decision-title").innerText(), locale === "enUS" ? "Your actions" : "你的操作");
  await assertOpponentHidden(page, state, `${policy}/${locale} initial snapshot`);
  return state;
}

async function returnToLobby(page, state, locale, nickname) {
  await page.locator('[data-testid="game-over"]').waitFor({ state: "visible", timeout: 60000 });
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/return", { timeout: 60000 });
  await page.locator("#game-over-return").click();
  const response = await responsePromise;
  const lobby = await response.json();
  assert.equal(response.status(), 200, `return to lobby failed: ${JSON.stringify(lobby)}`);
  assert.equal(lobby.mode, "lobby");
  await page.locator("#lobby-screen").waitFor({ state: "visible", timeout: 60000 });
  await page.locator("#game").waitFor({ state: "hidden", timeout: 60000 });
  const current = await page.evaluate(async () => (await fetch("/api/state", { cache: "no-store" })).json());
  assert.equal(current.mode, "lobby", "server must return to lobby state too");
  assert.equal(await page.locator("#nickname-input").inputValue(), nickname);
  await page.locator("#lobby-setup").waitFor({ state: "visible", timeout: 60000 });
  await page.locator("#lobby-login-actions").waitFor({ state: "hidden", timeout: 60000 });
  assert.equal(await page.locator(`#locale-${locale}`).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#start-match-button").innerText(), locale === "enUS" ? "Start match" : "开始对战");
}

async function playMatch(page, { policy, locale, nickname, screenshot }) {
  let state = await startMatchFromLobby(page, { policy, locale, nickname });
  const phases = new Set();
  const types = new Set();
  const routes = { direct: 0, "end-turn": 0, fallback: 0 };
  let lastAction = null;
  let steps = 0;
  for (; steps < 500 && !state.outcome; steps += 1) {
    phases.add(state.observation.phase);
    await assertOpponentHidden(page, state, `${policy}/${locale} step ${steps}`);
    const action = chooseAction(state);
    lastAction = action;
    types.add(action.type);
    const actionKey = await page.evaluate((value) => window.FireplaceActionModel.actionKey(value), action);
    const responsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/action", { timeout: 60000 });
    routes[await clickAction(page, action, actionKey)] += 1;
    const response = await responsePromise;
    const next = await response.json();
    assert.equal(response.status(), 200, `${policy}/${locale}: action rejected at step ${steps}: ${JSON.stringify(next)}`);
    assert(next.revision > state.revision, `${policy}/${locale}: revision did not advance`);
    await page.waitForFunction((revision) => {
      const match = document.querySelector('[data-testid="revision"]')?.textContent.match(/(\d+)/);
      return match && Number(match[1]) >= revision;
    }, next.revision, { timeout: 60000 });
    state = next;
  }
  assert(state.outcome, `${policy}/${locale}: no terminal result after ${steps} GUI decisions`);
  assert.equal(state.observation.phase, "GAME_OVER");
  assert(phases.has("MULLIGAN") && phases.has("MAIN"));
  assert(types.has("END_TURN"), `${policy}/${locale}: no turn ended through GUI`);
  assert(routes.direct >= 4, `${policy}/${locale}: direct battlefield actions were not exercised across turns`);
  assert(routes["end-turn"] >= 1, `${policy}/${locale}: dedicated end-turn button was not exercised`);
  assert(state.events.length > 40, `${policy}/${locale}: expected a multi-turn real match`);
  await page.locator('[data-testid="game-over"]').waitFor({ state: "visible", timeout: 60000 });
  assert.equal(await page.locator("#game-over-return").innerText(), locale === "enUS" ? "Return to lobby" : "返回开始界面");
  await page.screenshot({ path: path.join(artifacts, screenshot), fullPage: true });
  const result = { policy, locale, steps, phases: [...phases], types: [...types], routes, events: state.events.length, outcome: state.outcome };
  await returnToLobby(page, state, locale, nickname);
  return { result, staleAction: { session_id: state.session_id, revision: state.revision, action: lastAction } };
}

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const server = startServer();
  let context;
  try {
    const url = await server.ready;
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    // The separate quick browser test checks real art.  This long run keeps
    // network imagery offline so it verifies decision flow without downloads.
    await page.route("**/assets/**", (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator("#lobby-screen").waitFor({ state: "visible", timeout: 60000 });
    await page.locator("#lobby-login-actions").waitFor({ state: "visible", timeout: 60000 });
    await page.locator("#lobby-setup").waitFor({ state: "hidden", timeout: 60000 });
    const initial = await page.evaluate(async () => (await fetch("/api/state", { cache: "no-store" })).json());
    assert.equal(initial.mode, "lobby", "the browser must begin in the nickname lobby");

    const first = await playMatch(page, {
      policy: "random", locale: "zhCN", nickname: "Acceptance Player", screenshot: "web-gui-full-random-zhCN.png",
    });

    // Reuse the local server to prove the lobby can switch language and start a
    // fresh policy/session after a completed match.
    const second = await playMatch(page, {
      policy: "heuristic", locale: "enUS", nickname: "Acceptance Player", screenshot: "web-gui-full-heuristic-enUS.png",
    });
    const fresh = await page.evaluate(async () => (await fetch("/api/state", { cache: "no-store" })).json());
    assert.equal(fresh.mode, "lobby");
    assert.notEqual(first.staleAction.session_id, second.staleAction.session_id, "each match needs a fresh session id");
    const staleResponse = await page.evaluate(async (body) => {
      const response = await fetch("/api/action", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: response.status, payload: await response.json() };
    }, first.staleAction);
    assert.equal(staleResponse.status, 409, "actions from the completed match must remain stale after a new session");
    assert.equal(staleResponse.payload.mode, "lobby");
    const results = [first.result, second.result];
    console.log(JSON.stringify({ result: "PASS", results, artifacts }, null, 2));
  } finally {
    if (context) await context.close();
    await stopServer(server.child);
    await browser.close();
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
