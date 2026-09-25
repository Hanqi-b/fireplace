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

function startServer(policy) {
  const child = spawn(python, ["-u", "-m", "fireplace.web_gui", "--seed", "2", "--opponent", policy, "--port", "0"], {
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

async function play(browser, policy) {
  const server = startServer(policy);
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
    let state = await page.evaluate(async () => (await fetch("/api/state", { cache: "no-store" })).json());
    const phases = new Set();
    const types = new Set();
    const routes = { direct: 0, "end-turn": 0, fallback: 0 };
    let steps = 0;
    for (; steps < 500 && !state.outcome; steps += 1) {
      phases.add(state.observation.phase);
      assert(!Object.hasOwn(state.observation.opponent, "hand"), "opponent hand leaked to browser");
      const action = chooseAction(state);
      types.add(action.type);
      const actionKey = await page.evaluate((value) => window.FireplaceActionModel.actionKey(value), action);
      const responsePromise = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api/action", { timeout: 60000 });
      routes[await clickAction(page, action, actionKey)] += 1;
      const response = await responsePromise;
      const next = await response.json();
      assert.equal(response.status(), 200, `${policy}: action rejected at step ${steps}: ${JSON.stringify(next)}`);
      assert(next.revision > state.revision, `${policy}: revision did not advance`);
      await page.waitForFunction((revision) => {
        const match = document.querySelector('[data-testid="revision"]')?.textContent.match(/(\d+)/);
        return match && Number(match[1]) >= revision;
      }, next.revision, { timeout: 60000 });
      state = next;
    }
    assert(state.outcome, `${policy}: no terminal result after ${steps} GUI decisions`);
    assert.equal(state.observation.phase, "GAME_OVER");
    assert(phases.has("MULLIGAN") && phases.has("MAIN"));
    assert(types.has("END_TURN"), `${policy}: no turn ended through GUI`);
    assert(routes.direct >= 4, `${policy}: direct battlefield actions were not exercised across turns`);
    assert(routes["end-turn"] >= 1, `${policy}: dedicated end-turn button was not exercised`);
    assert(state.events.length > 40, `${policy}: expected a multi-turn real match`);
    await page.locator('[data-testid="game-over"]').waitFor({ state: "visible", timeout: 60000 });
    await page.screenshot({ path: path.join(artifacts, `web-gui-full-${policy}.png`), fullPage: true });
    return { policy, steps, phases: [...phases], types: [...types], routes, events: state.events.length, outcome: state.outcome };
  } finally {
    if (context) await context.close();
    await stopServer(server.child);
  }
}

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const results = [];
    for (const policy of ["random", "heuristic"]) results.push(await play(browser, policy));
    console.log(JSON.stringify({ result: "PASS", results, artifacts }, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
