import assert from "node:assert/strict";
import { test } from "node:test";

const hookHandlers = new Map();
const registeredSettings = new Map();
const registeredMenus = new Map();
const notices = [];
const applications = [];
const moduleRecord = {};
let fetchCalls = 0;
let fetchFails = false;

class MockApplication {
  static get defaultOptions() { return { classes: [] }; }
  constructor(options = {}) {
    this.options = { ...this.constructor.defaultOptions, ...options };
    this.renderCalls = [];
    applications.push(this);
  }
  render(force, options) {
    this.renderCalls.push({ force, options });
    return this;
  }
  async close() { return this; }
  activateListeners() {}
}

function mergeObject(original, other, { inplace = true } = {}) {
  const result = inplace ? original : structuredClone(original);
  for (const [key, value] of Object.entries(other)) {
    if (value && typeof value === "object" && !Array.isArray(value)
        && result[key] && typeof result[key] === "object") {
      result[key] = mergeObject(result[key], value, { inplace: false });
    } else result[key] = value;
  }
  return result;
}

Object.assign(globalThis, {
  Application: MockApplication,
  FormApplication: class extends MockApplication {},
  foundry: { utils: { mergeObject } },
  Hooks: {
    once(name, callback) { hookHandlers.set(name, callback); },
    on(name, callback) { hookHandlers.set(name, callback); },
  },
  game: {
    user: { id: "test-gm", isGM: true },
    modules: { get: () => moduleRecord },
    settings: {
      register(moduleId, name, definition) { registeredSettings.set(name, { moduleId, ...definition }); },
      registerMenu(moduleId, name, definition) { registeredMenus.set(name, { moduleId, ...definition }); },
      get() { return undefined; },
      async set(_module, _name, value) { return value; },
    },
    i18n: { localize: text => text },
  },
  ui: { notifications: {
    warn: text => notices.push({ level: "warn", text }),
    error: text => notices.push({ level: "error", text }),
    info: text => notices.push({ level: "info", text }),
  } },
  fetch: async () => {
    fetchCalls += 1;
    return {
      ok: !fetchFails,
      status: fetchFails ? 503 : 200,
      async json() { return { schemaVersion: 1, map: { width: 1200, height: 1855 }, locations: [] }; },
    };
  },
});

const module = await import("../scripts/main.js");

test("actual entry registers only GM-facing settings and an explicit menu", async () => {
  assert.equal(module.MODULE_ID, "night-city-2045-atlas");
  assert.equal(typeof module.openAtlas, "function");
  assert.ok(hookHandlers.has("init"));
  assert.ok(hookHandlers.has("ready"));
  assert.ok(hookHandlers.has("getSceneControlButtons"));
  await hookHandlers.get("init")();
  for (const [name, type, initialValue] of [["favorites", Array, []], ["customPins", Object, {}]]) {
    const definition = registeredSettings.get(name);
    assert.ok(definition, `${name} setting not registered`);
    assert.equal(definition.moduleId, module.MODULE_ID);
    assert.equal(definition.scope, "client");
    assert.equal(definition.config, false);
    assert.equal(definition.type, type);
    assert.deepEqual(definition.default, initialValue);
  }
  const menu = [...registeredMenus.values()].find(definition => definition.restricted);
  assert.ok(menu, "Restricted atlas menu is missing");
  assert.equal(menu.moduleId, module.MODULE_ID);
  assert.ok(menu.type.prototype instanceof FormApplication);
  assert.equal(applications.length, 0, "Init must not open the atlas automatically");
});

test("scene control is added for a GM and omitted for a player", async () => {
  game.user.isGM = true;
  const controls = [{ name: "token", tools: [] }, { name: "notes", tools: [] }];
  await hookHandlers.get("getSceneControlButtons")(controls);
  const atlas = controls.flatMap(control => control.tools).find(tool => tool.name === "nightCityAtlas");
  assert.ok(atlas, "Atlas scene-control button missing for GM");
  assert.equal(atlas.button, true);
  assert.equal(atlas.visible, true);
  assert.equal(typeof atlas.onClick, "function");
  await hookHandlers.get("getSceneControlButtons")(controls);
  assert.equal(controls.flatMap(control => control.tools).filter(tool => tool.name === "nightCityAtlas").length, 1,
               "Repeated scene-control renders must not duplicate the atlas tool");
  const fallbackControls = [{ name: "token", tools: [] }];
  await hookHandlers.get("getSceneControlButtons")(fallbackControls);
  assert.ok(fallbackControls[0].tools.some(tool => tool.name === "nightCityAtlas"),
            "Atlas entry must still exist when the Notes control group is absent");
  game.user.isGM = false;
  const playerControls = [{ name: "notes", tools: [] }];
  await hookHandlers.get("getSceneControlButtons")(playerControls);
  assert.equal(playerControls[0].tools.some(tool => tool.name === "nightCityAtlas" && tool.visible !== false), false);
  game.user.isGM = true;
});

test("public API and direct opener reject non-GM access without constructing an application", async () => {
  game.user.isGM = false;
  await hookHandlers.get("ready")();
  assert.equal(moduleRecord.api, undefined, "A player's ready hook must not expose the GM atlas API");
  game.user.isGM = true;
  await hookHandlers.get("ready")();
  assert.equal(moduleRecord.api.open, module.openAtlas);
  assert.equal(applications.length, 0, "Ready must not open the atlas automatically");
  game.user.isGM = false;
  const count = applications.length;
  const networkCount = fetchCalls;
  assert.equal(await moduleRecord.api.open(), null);
  assert.equal(applications.length, count);
  assert.equal(fetchCalls, networkCount, "Non-GM opener must not request atlas data");
  assert.ok(notices.some(notice => notice.level === "warn"));
  game.user.isGM = true;
});

test("a failed data request reports the error and remains retryable", async context => {
  const errorLog = context.mock.method(console, "error", () => {});
  fetchFails = true;
  const before = fetchCalls;
  const count = applications.length;
  assert.equal(await module.openAtlas(), null);
  assert.equal(fetchCalls, before + 1);
  assert.equal(applications.length, count, "Broken data must not open a blank application");
  assert.ok(notices.some(notice => notice.level === "error"));
  assert.ok(errorLog.mock.callCount() > 0, "Data loading failure must remain diagnosable in the console");
  fetchFails = false;
});

test("GM opener renders and reuses one application; menu uses the same entry", async () => {
  const beforeFetch = fetchCalls;
  const first = await module.openAtlas();
  assert.equal(fetchCalls, beforeFetch + 1, "Failed dataset promise must reset so the next open retries");
  assert.ok(first instanceof MockApplication);
  assert.equal(first.renderCalls.at(-1).force, true);
  const second = await module.openAtlas();
  assert.equal(fetchCalls, beforeFetch + 1, "Successful reference snapshot should be cached");
  assert.equal(second, first);
  const menuDefinition = [...registeredMenus.values()].find(definition => definition.restricted);
  const menu = new menuDefinition.type();
  const before = first.renderCalls.length;
  assert.equal(menu.render(true), menu);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(first.renderCalls.length, before + 1);
});
