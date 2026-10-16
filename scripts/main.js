import { AtlasApplication, loadAtlasData } from "./atlas-application.js";
import { emptyCity, cityId, projectCity } from './city-model.js';
import { canOpenAtlas } from './city-integrations.js';

export const MODULE_ID = "night-city-2045-atlas";
let application;

/** Players can open the public city only after the GM opts in. */
export async function openAtlas(locationId) {
  if (!canOpenAtlas()) {
    ui.notifications.warn("Мастер ещё не включил доступ игроков к атласу.");
    return null;
  }
  try {
    await loadAtlasData();
    // Recheck after the asynchronous request in case the active user changed.
    if (!canOpenAtlas()) return null;
    application ??= new AtlasApplication();
    if (typeof locationId === 'string') application.focusLocation(cityId(locationId));
    application.render(true);
    return application;
  } catch (error) {
    console.error(`${MODULE_ID}: could not open atlas`, error);
    ui.notifications.error("Не удалось открыть атлас. Проверьте установку модуля и повторите попытку.");
    return null;
  }
}

export class AtlasMenu extends FormApplication {
  render() {
    void openAtlas();
    return this;
  }

  async _updateObject() {}
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, 'cityState', { scope: 'world', config: false, type: Object, default: emptyCity() });
  game.settings.register(MODULE_ID, 'importBackup', { scope: 'client', config: false, type: String, default: '' });
  game.settings.register(MODULE_ID, 'playerAccess', { name: 'Открыть атлас игрокам',
    hint: 'Игроки смогут читать справочник, общие места и маршруты, ставить свою метку. Общие данные города доступны участникам; секретные заметки храните в журналах или «Агенте».',
    scope: 'world', config: true, type: Boolean, default: false,
    onChange: () => { application?.refreshCity(); ui.controls?.render(); Hooks.callAll?.('nightCityAtlasAccessChanged'); } });
  game.keybindings?.register(MODULE_ID, 'open', { name: 'Открыть атлас Найт-Сити',
    editable: [{ key: 'KeyM', modifiers: ['SHIFT'] }], onDown: () => { void openAtlas(); return true; } });
  game.settings.register(MODULE_ID, "favorites", {
    name: "Избранные места Найт-Сити",
    scope: "client",
    config: false,
    type: Array,
    default: []
  });
  game.settings.register(MODULE_ID, "customPins", {
    name: "Пользовательские метки Найт-Сити",
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });
  game.settings.registerMenu(MODULE_ID, "openAtlas", {
    name: "Атлас Найт-Сити 2045",
    label: "Открыть карту",
    hint: "Карта, места и маршруты города. Доступ игроков включает Мастер.",
    icon: "fas fa-map-marked-alt",
    type: AtlasMenu,
    restricted: true
  });
});

Hooks.on("getSceneControlButtons", controls => {
  if (!canOpenAtlas() || !Array.isArray(controls)) return;
  const group = controls.find(control => control.name === "notes")
    ?? controls.find(control => control.name === "token") ?? controls[0];
  if (!group?.tools || group.tools.some(tool => tool.name === "nightCityAtlas")) return;
  group.tools.push({
    name: "nightCityAtlas",
    title: "Атлас Найт-Сити 2045",
    icon: "fas fa-map-marked-alt",
    visible: true,
    button: true,
    onClick: () => void openAtlas()
  });
});

Hooks.once("ready", () => {
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = { open: openAtlas, openLocation: openAtlas, canOpen: canOpenAtlas,
    listLocations: async () => {
      if (!canOpenAtlas()) return [];
      const data = await loadAtlasData();
      if (!canOpenAtlas()) return [];
      const state = game.settings.get(MODULE_ID, 'cityState') ?? emptyCity();
      return projectCity(data, state).locations.map(({ id, name }) => ({ id, name }));
    } };
});

Hooks.on('updateSetting', setting => { if (setting.key?.startsWith(`${MODULE_ID}.`)) application?.refreshCity(); });
Hooks.on('updateUser', () => application?.refreshCity());
Hooks.on('updateWorldTime', () => application?.refreshCity(false));
Hooks.on('simple-calendar-date-time-change', () => application?.refreshCity(false));
