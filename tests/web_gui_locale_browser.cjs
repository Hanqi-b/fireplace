#!/usr/bin/env node
/* Real-browser check for localized card descriptions and rendered art bytes. */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const fixture = path.join(__dirname, "web_gui_locale_fixture.py");
const python = process.env.FIREPLACE_GUI_PYTHON || process.env.PYTHON || "python3";
const chrome = process.env.CHROME_PATH || "/opt/google/chrome/chrome";
const artifacts = process.env.FIREPLACE_GUI_ARTIFACTS || "/tmp/fireplace-web-gui-lobby-artifacts";
const timeout = Number(process.env.FIREPLACE_GUI_TIMEOUT_MS || 30000);

function startFixture() {
  const child = spawn(python, ["-u", fixture, "--port", "0"], {
    cwd: root,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const lines = readline.createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`locale fixture startup timed out\n${logs.join("")}`)), 30000);
    const remember = (line) => {
      logs.push(`${line}\n`);
      try {
        const value = JSON.parse(line);
        if (value && typeof value.url === "string" && value.contracts) {
          clearTimeout(timer);
          resolve(value);
        }
      } catch (_error) {
        // Startup diagnostics can precede the fixture's single JSON line.
      }
    };
    lines.on("line", remember);
    child.stderr.on("data", (chunk) => logs.push(String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`locale fixture exited before ready (code=${code}, signal=${signal})\n${logs.join("")}`));
    });
  });
  return { child, ready };
}

async function stopFixture(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function stateFromPage(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/state", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`GET /api/state failed: ${response.status}`);
    return response.json();
  });
}

async function waitForDescription(page, locale, contract) {
  await page.waitForFunction(async ({ expectedLocale, expectedName, expectedText }) => {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) return false;
    const state = await response.json();
    const cards = [
      ...(state.observation?.self?.hand || []),
      ...(state.observation?.self?.board || []),
    ];
    return state.locale === expectedLocale && cards.some((card) =>
      card.card_id === "CS2_231" && card.locale === expectedLocale &&
      card.name === expectedName && card.text === expectedText);
  }, { expectedLocale: locale, expectedName: contract.name, expectedText: contract.text }, { timeout });
  const state = await stateFromPage(page);
  assert.equal(state.locale, locale);
  const card = state.observation.self.hand.find((candidate) => candidate.card_id === "CS2_231");
  assert(card, `${locale}: fixture card should be visible in the real opening hand`);
  assert.equal(card.name, contract.name);
  assert.equal(card.text, contract.text);
  assert.equal(card.locale, locale);
  return { state, card };
}

async function startMatch(page, locale, policy, nickname, contract) {
  await page.locator(`#locale-${locale}`).click();
  await page.locator("#nickname-input").fill(nickname);
  const enter = page.locator("#enter-lobby-button");
  if (await enter.isVisible()) {
    await enter.click();
  }
  await page.locator("#lobby-setup").waitFor({ state: "visible", timeout });
  await page.locator(`input[name="opponent"][value="${policy}"]`).check();

  const imageResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/assets/render/CS2_231" && response.status() === 200;
  }, { timeout });
  const startResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/start", { timeout });
  await page.locator("#start-match-button").click();
  const startResponse = await startResponsePromise;
  const started = await startResponse.json();
  assert.equal(startResponse.status(), 200, `${locale}: start failed: ${JSON.stringify(started)}`);
  assert.equal(started.mode, "match");
  assert.equal(started.locale, locale);
  assert.equal(started.nickname, nickname);
  await page.waitForFunction(() =>
    document.querySelector("#lobby-screen").hidden && !document.querySelector("#game").hidden,
  null, { timeout });

  const { state, card } = await waitForDescription(page, locale, contract);
  await page.evaluate(() => window.fireplaceWebGui.loadState(true));
  const cardSelector = `[data-testid="hand-card"][data-entity-id="${card.entity_id}"]`;
  await page.locator(cardSelector).scrollIntoViewIfNeeded();
  await page.waitForFunction((selector) => {
    const image = document.querySelector(selector + " .card-art img");
    return image && !image.hidden && image.naturalWidth === 1 && image.naturalHeight === 1;
  }, cardSelector, { timeout });

  const imageResponse = await imageResponsePromise;
  assert.equal(imageResponse.headers()["content-type"], "image/png");
  assert.equal(imageResponse.headers()["x-asset-placeholder"], "0");
  const expectedBytes = Buffer.from(contract.png_base64, "base64");
  assert.deepEqual(await imageResponse.body(), expectedBytes, `${locale}: asset route returned the wrong PNG bytes`);

  const domCard = page.locator(cardSelector);
  assert.equal(await domCard.locator(".card-name").innerText(), contract.name);
  assert.equal(await domCard.locator(".card-text").innerText(), contract.text);
  const domImage = domCard.locator(".card-art img");
  const imageData = await domImage.evaluate(async (image) => ({
    src: image.src,
    alt: image.alt,
    bytes: Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer())),
  }));
  assert(imageData.src.startsWith("blob:"), `${locale}: rendered art must be a local object URL`);
  assert.match(imageData.alt, new RegExp(contract.name));
  assert.deepEqual(Buffer.from(imageData.bytes), expectedBytes, `${locale}: rendered DOM image bytes differ from local asset route`);

  if (locale === "enUS") {
    const serializedCard = JSON.stringify(card);
    assert(!serializedCard.includes("中文资源契约文本"), "English card data must never contain the Chinese fixture text");
    assert(!serializedCard.includes("测试小精灵"), "English card data must never contain the Chinese fixture name");
  }
  await page.screenshot({ path: path.join(artifacts, `web-gui-locale-${locale}.png`), fullPage: true });
  return { locale, policy, sessionId: state.session_id, state, cardId: card.card_id, name: card.name, text: card.text, imageBytes: expectedBytes.length };
}

async function finishFixtureMatch(page) {
  let state = await stateFromPage(page);
  assert.equal(state.observation.phase, "MULLIGAN");
  const keep = state.legal_actions.find((action) => action.type === "MULLIGAN" && action.mulligan_entity_ids.length === 0);
  assert(keep, "fixture must expose the legal keep-all Mulligan Action");
  const actionKey = await page.evaluate((action) => window.FireplaceActionModel.actionKey(action), keep);
  const fallback = page.locator("#action-fallback");
  if (!(await fallback.evaluate((node) => node.open))) await fallback.locator("summary").click();
  const buttons = page.locator("#action-menu .action-button");
  const index = await buttons.evaluateAll((nodes, key) =>
    nodes.findIndex((node) => node.getAttribute("data-action-key") === key), actionKey);
  assert(index >= 0, "raw keep-all Action should be offered in the GUI action menu");
  const mulliganResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/action", { timeout });
  await buttons.nth(index).click();
  const mulliganResponse = await mulliganResponsePromise;
  state = await mulliganResponse.json();
  assert.equal(mulliganResponse.status(), 200, `fixture Mulligan failed: ${JSON.stringify(state)}`);
  assert.equal(state.observation.phase, "MAIN");

  const fireball = state.observation.self.hand.find((card) => card.card_id === "CS2_029");
  assert(fireball, "fixture should provide Fireball for a quick terminal action");
  const target = state.observation.opponent.hero.entity_id;
  const finishResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/action", { timeout });
  await page.locator(`#hand [data-testid="hand-card"][data-entity-id="${fireball.entity_id}"]`).click();
  await page.locator(`#opponent-hero-row .targetable[data-entity-id="${target}"]`).waitFor({ state: "visible", timeout });
  await page.locator(`#opponent-hero-row .targetable[data-entity-id="${target}"]`).click();
  const finishedResponse = await finishResponsePromise;
  const finished = await finishedResponse.json();
  assert.equal(finishedResponse.status(), 200, `fixture lethal failed: ${JSON.stringify(finished)}`);
  assert.equal(finished.observation.phase, "GAME_OVER");
  assert(finished.outcome);

  const returnResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/return", { timeout });
  await page.locator("#game-over-return").click();
  const returnedResponse = await returnResponsePromise;
  const lobby = await returnedResponse.json();
  assert.equal(returnedResponse.status(), 200, `return to lobby failed: ${JSON.stringify(lobby)}`);
  assert.equal(lobby.mode, "lobby");
  await page.locator("#lobby-screen").waitFor({ state: "visible", timeout });
  await page.locator("#lobby-setup").waitFor({ state: "visible", timeout });
}

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const server = startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  let context;
  try {
    const fixtureInfo = await server.ready;
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    // Keep this tab's match snapshot frozen so the later cross-tab stale
    // response must update its language and game state immediately.
    await page.addInitScript(() => {
      const realSetInterval = window.setInterval.bind(window);
      window.setInterval = function (callback, delay, ...args) {
        if (delay === 2500) return -1;
        return realSetInterval(callback, delay, ...args);
      };
    });
    const nonLocalRequests = [];
    const watchLocalRequests = (targetPage) => targetPage.on("request", (request) => {
      if (new URL(request.url()).origin !== new URL(fixtureInfo.url).origin) nonLocalRequests.push(request.url());
    });
    watchLocalRequests(page);
    await page.goto(fixtureInfo.url, { waitUntil: "domcontentloaded" });
    await page.locator("#lobby-screen").waitFor({ state: "visible", timeout });
    const initial = await stateFromPage(page);
    assert.equal(initial.mode, "lobby");
    await page.setViewportSize({ width: 390, height: 844 });
    const lobbyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert(lobbyWidth <= 390, `narrow lobby overflowed viewport: ${lobbyWidth}px`);
    const enterBounds = await page.locator("#enter-lobby-button").boundingBox();
    assert(enterBounds && enterBounds.width >= 44 && enterBounds.height >= 44,
      `narrow lobby entry control is too small: ${JSON.stringify(enterBounds)}`);
    await page.screenshot({ path: path.join(artifacts, "web-gui-lobby-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    // Leave a concrete localized lobby screenshot for visual review.
    await page.locator("#locale-enUS").click();
    await page.locator("#nickname-input").fill("Locale Fixture Player");
    await page.locator("#enter-lobby-button").click();
    await page.locator("#lobby-setup").waitFor({ state: "visible", timeout });
    assert.equal(await page.locator("#start-match-button").innerText(), "Start match");
    assert.equal(await page.locator("#opponent-heuristic-title").innerText(), "Smart AI");
    await page.screenshot({ path: path.join(artifacts, "web-gui-lobby-enUS.png"), fullPage: true });

    const chinese = await startMatch(page, "zhCN", "random", "Locale Fixture Player", fixtureInfo.contracts.zhCN);
    assert.equal(chinese.state.observation.phase, "MULLIGAN");
    const oldActionIndex = chinese.state.legal_actions.findIndex((action) =>
      action.type === "MULLIGAN" && action.mulligan_entity_ids.length === 0);
    assert(oldActionIndex >= 0, "Chinese match must retain an old legal action for stale-session testing");

    const secondTab = await context.newPage();
    secondTab.setDefaultTimeout(timeout);
    watchLocalRequests(secondTab);
    await secondTab.goto(fixtureInfo.url, { waitUntil: "domcontentloaded" });
    await secondTab.waitForFunction(() => !document.querySelector("#game").hidden, null, { timeout });
    const secondTabState = await stateFromPage(secondTab);
    assert.equal(secondTabState.session_id, chinese.sessionId, "both tabs should begin on the same Chinese match");
    await finishFixtureMatch(secondTab);

    const english = await startMatch(secondTab, "enUS", "heuristic", "Locale Fixture Player", fixtureInfo.contracts.enUS);

    const staleResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/action" && response.status() === 409,
    { timeout });
    const staleRequestPromise = page.waitForRequest((request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/action", { timeout });
    await page.evaluate((index) => window.fireplaceWebGui.submitAction(index), oldActionIndex);
    const [staleRequest, staleResponse] = await Promise.all([staleRequestPromise, staleResponsePromise]);
    const staleBody = staleRequest.postDataJSON();
    assert.equal(staleBody.session_id, chinese.sessionId, "the first tab must actually submit its old session");
    const stalePayload = await staleResponse.json();
    assert.equal(stalePayload.mode, "match");
    assert.equal(stalePayload.locale, "enUS");
    assert.notEqual(stalePayload.session_id, chinese.sessionId);
    await page.waitForFunction(() =>
      document.documentElement.lang === "en" &&
      document.querySelector("#hand-title")?.textContent === "Your hand" &&
      !document.querySelector("#game").hidden,
    null, { timeout: 5000 });
    const refreshedTabState = await waitForDescription(page, "enUS", fixtureInfo.contracts.enUS);
    assert.equal(refreshedTabState.state.session_id, english.sessionId);
    await page.waitForFunction(({ name, text }) => {
      const card = [...document.querySelectorAll('#hand [data-testid="hand-card"]')]
        .find((node) => node.querySelector(".card-name")?.textContent === name);
      return card && card.querySelector(".card-text")?.textContent === text;
    }, { name: fixtureInfo.contracts.enUS.name, text: fixtureInfo.contracts.enUS.text }, { timeout });

    await finishFixtureMatch(secondTab);
    assert.deepEqual(nonLocalRequests, [], "the locale asset smoke must remain entirely local");

    console.log(JSON.stringify({
      result: "PASS",
      matches: [
        { locale: chinese.locale, sessionId: chinese.sessionId, cardId: chinese.cardId, name: chinese.name, text: chinese.text, imageBytes: chinese.imageBytes },
        { locale: english.locale, sessionId: english.sessionId, cardId: english.cardId, name: english.name, text: english.text, imageBytes: english.imageBytes },
      ],
      crossTabStale: { status: staleResponse.status(), refreshedLocale: refreshedTabState.state.locale },
      artifacts,
      requests: "loopback only",
    }, null, 2));
  } finally {
    if (context) await context.close();
    await stopFixture(server.child);
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
