import { AtlasMapController } from "./map-controller.js";

const MODULE_ID = "night-city-2045-atlas";
const ASSET_BASE = `modules/${MODULE_ID}/`;
let datasetPromise;

/** Load one immutable reference snapshot; retry a failed request on the next open. */
export function loadAtlasData() {
  if (!datasetPromise) {
    datasetPromise = fetch(`${ASSET_BASE}data/locations.json`)
      .then(async response => {
        if (!response.ok) throw new Error(`Данные атласа недоступны (HTTP ${response.status}).`);
        const dataset = await response.json();
        if (dataset.schemaVersion !== 1 || !Array.isArray(dataset.locations)
          || !Number.isFinite(dataset.map?.width) || !Number.isFinite(dataset.map?.height)
          || dataset.map.width <= 0 || dataset.map.height <= 0) {
          throw new Error("Формат данных атласа не поддерживается.");
        }
        return dataset;
      })
      .catch(error => {
        datasetPromise = undefined;
        throw error;
      });
  }
  return datasetPromise;
}

/** Foundry v12's supported legacy Application, backed by a plain DOM controller. */
export class AtlasApplication extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "night-city-2045-atlas",
      title: "Найт-Сити 2045 — Атлас Мастера",
      template: `${ASSET_BASE}templates/atlas.hbs`,
      classes: ["night-city-atlas-window"],
      width: 1240,
      height: 820,
      resizable: true,
      minimizable: true
    });
  }

  render(force = false, options = {}) {
    if (!game.user?.isGM) {
      ui.notifications.warn("Атлас Найт-Сити доступен только Мастеру.");
      return this;
    }
    return super.render(force, options);
  }

  async getData() {
    this._atlasDataset = await loadAtlasData();
    return {};
  }

  activateListeners(html) {
    super.activateListeners(html);
    this._atlasController?.destroy();
    const root = html[0]?.querySelector(".nc-atlas") ?? html[0];
    this._atlasController = new AtlasMapController(root, this._atlasDataset, {
      assetBase: ASSET_BASE,
      isGM: () => Boolean(game.user?.isGM),
      getFavorites: () => game.settings.get(MODULE_ID, "favorites"),
      getCustomPins: () => game.settings.get(MODULE_ID, "customPins"),
      saveFavorites: value => game.settings.set(MODULE_ID, "favorites", value),
      saveCustomPins: value => game.settings.set(MODULE_ID, "customPins", value),
      notify: message => ui.notifications.error(message)
    });
  }

  async close(options = {}) {
    this._atlasController?.destroy();
    this._atlasController = undefined;
    return super.close(options);
  }
}
