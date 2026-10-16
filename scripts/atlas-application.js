import { AtlasMapController } from "./map-controller.js";
import { CityControls } from './city-controls.js';
import { projectCity } from './city-model.js';
import { createCityStore } from './city-store.js';
import { assertCityGM, canOpenAtlas, createCityAdapters } from './city-integrations.js';

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
      title: "Найт-Сити 2045 — Атлас кампании",
      template: `${ASSET_BASE}templates/atlas.hbs`,
      classes: ["night-city-atlas-window"],
      width: 1240,
      height: 820,
      resizable: true,
      minimizable: true
    });
  }

  render(force = false, options = {}) {
    if (!canOpenAtlas()) {
      ui.notifications.warn("Мастер ещё не включил доступ игроков к атласу.");
      return this;
    }
    return super.render(force, options);
  }

  async getData() {
    this._atlasDataset = await loadAtlasData();
    this._cityStore ??= createCityStore({
      read: () => game.settings.get(MODULE_ID, 'cityState'),
      write: value => game.settings.set(MODULE_ID, 'cityState', value),
      baseIds: new Set(this._atlasDataset.locations.map(p => p.id)),
      authorize: assertCityGM, newId: () => `custom-${foundry.utils.randomID()}`
    });
    return { isGM: Boolean(game.user?.isGM) };
  }

  activateListeners(html) {
    super.activateListeners(html);
    this._cityControls?.destroy();
    this._atlasController?.destroy();
    const root = html[0]?.querySelector(".nc-atlas") ?? html[0];
    const state = this._cityStore.read();
    this._atlasController = new AtlasMapController(root, projectCity(this._atlasDataset, state), {
      assetBase: ASSET_BASE,
      isGM: () => Boolean(game.user?.isGM),
      getFavorites: () => game.settings.get(MODULE_ID, "favorites"),
      getCustomPins: () => game.user?.isGM ? game.settings.get(MODULE_ID, "customPins") : {},
      saveFavorites: value => game.settings.set(MODULE_ID, "favorites", value),
      saveCustomPins: value => game.settings.set(MODULE_ID, "customPins", value),
      notify: message => ui.notifications.error(message)
    });
    this._cityControls = new CityControls(root, this._atlasController,
      createCityAdapters({ store: this._cityStore, dataset: this._atlasDataset, refresh: () => this.refreshCity() }));
    if (this._focusLocation) this._atlasController.selectLocation(this._focusLocation, true);
  }

  focusLocation(id) {
    this._focusLocation = id;
    this._atlasController?.selectLocation(id, true);
  }

  refreshCity(replace = true) {
    if (!canOpenAtlas()) { if (this.rendered) void this.close(); return; }
    if (!this._atlasController || !this._cityStore) return;
    try {
      const state = this._cityStore.read();
      if (replace) this._atlasController.replaceDataset(projectCity(this._atlasDataset, state));
      this._cityControls?.update(state);
    } catch (error) { console.error(`${MODULE_ID}: city refresh`, error); ui.notifications.error(error.message); }
  }

  async close(options = {}) {
    this._cityControls?.destroy();
    this._cityControls = undefined;
    this._atlasController?.destroy();
    this._atlasController = undefined;
    return super.close(options);
  }
}
