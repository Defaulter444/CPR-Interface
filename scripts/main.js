import { AtlasApplication, loadAtlasData } from "./atlas-application.js";

export const MODULE_ID = "night-city-2045-atlas";
let application;

/** Open the GM atlas; players cannot instantiate it through this entry point. */
export async function openAtlas() {
  if (!game.user?.isGM) {
    ui.notifications.warn("Атлас Найт-Сити доступен только Мастеру.");
    return null;
  }
  try {
    await loadAtlasData();
    // Recheck after the asynchronous request in case the active user changed.
    if (!game.user?.isGM) return null;
    application ??= new AtlasApplication();
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
    hint: "Карта города, поиск мест и описания из вики для Мастера.",
    icon: "fas fa-map-marked-alt",
    type: AtlasMenu,
    restricted: true
  });
});

Hooks.on("getSceneControlButtons", controls => {
  if (!game.user?.isGM || !Array.isArray(controls)) return;
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
  if (module && game.user?.isGM) module.api = { open: openAtlas };
});
