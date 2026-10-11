const DEFAULT_STATUS = "Перетаскивайте карту · колёсико меняет масштаб";

export function normalizeSearch(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("ru").replace(/ё/g, "е");
}

export function isValidPin(pin) {
  return Boolean(pin && Number.isFinite(pin.x) && Number.isFinite(pin.y)
    && pin.x >= 0 && pin.x <= 1 && pin.y >= 0 && pin.y <= 1);
}

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = String(text);
  return result;
}

function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

/** DOM map controller. Coordinates in both the source data and settings are normalized 0..1. */
export class AtlasMapController {
  constructor(root, dataset, adapters = {}) {
    this.root = root;
    this.dataset = dataset;
    this.adapters = adapters;
    this.abort = new AbortController();
    this.destroyed = false;
    this.locations = dataset.locations;
    this.byId = new Map(this.locations.map(location => [location.id, location]));
    this.favoriteIds = new Set((adapters.getFavorites?.() ?? []).filter(id => this.byId.has(id)));
    this.customPins = {};
    for (const [id, pin] of Object.entries(adapters.getCustomPins?.() ?? {})) {
      if (this.byId.has(id) && isValidPin(pin)) this.customPins[id] = { x: pin.x, y: pin.y };
    }
    this.searchIndex = new Map(this.locations.map(location => [location.id, normalizeSearch([
      location.name, location.district, ...(location.aliases ?? []),
      ...(location.originalMapReferences ?? []).flatMap(reference => [reference.number, reference.name]),
      ...(location.mapMarkers ?? []).map(marker => marker.code)
    ].join(" "))]));
    this.state = { query: "", district: "", placedOnly: false, favoritesOnly: false, selectedId: null, placement: false };
    this.view = { scale: 1, x: 0, y: 0 };
    this.nodes = Object.fromEntries(Array.from(root.querySelectorAll("[data-role]")).map(node => [node.dataset.role, node]));
    this.nodes.stage.style.width = `${dataset.map.width}px`;
    this.nodes.stage.style.height = `${dataset.map.height}px`;
    this.listen(this.nodes["map-image"], "error", () => { this.nodes["map-error"].hidden = false; });
    this.nodes["map-image"].src = `${adapters.assetBase ?? ""}${dataset.map.path}`;
    this.populateDistricts();
    this.bindEvents();
    this.renderResults();
    this.updateSummary();
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.nodes.viewport);
    this.fit();
  }

  listen(node, name, callback, options = {}) {
    node.addEventListener(name, callback, { ...options, signal: this.abort.signal });
  }

  populateDistricts() {
    const districts = [...new Set(this.locations.map(location => location.district).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "ru"));
    for (const name of districts) {
      const option = element("option", "", name);
      option.value = name;
      this.nodes.district.append(option);
    }
  }

  bindEvents() {
    this.listen(this.nodes.search, "input", () => { this.state.query = this.nodes.search.value; this.renderResults(); });
    this.listen(this.nodes.district, "change", () => { this.state.district = this.nodes.district.value; this.renderResults(); });
    this.listen(this.nodes["placed-only"], "change", () => { this.state.placedOnly = this.nodes["placed-only"].checked; this.renderResults(); });
    this.listen(this.nodes["favorites-only"], "change", () => { this.state.favoritesOnly = this.nodes["favorites-only"].checked; this.renderResults(); });
    this.listen(this.root, "click", event => this.handleAction(event));
    this.listen(this.nodes.viewport, "wheel", event => {
      event.preventDefault();
      const rect = this.nodes.viewport.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      this.zoom(Math.exp(-delta * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    this.listen(this.nodes.viewport, "pointerdown", event => this.pointerDown(event));
    this.listen(this.nodes.viewport, "pointermove", event => this.pointerMove(event));
    this.listen(this.nodes.viewport, "pointerup", event => this.pointerUp(event));
    this.listen(this.nodes.viewport, "pointercancel", () => this.cancelDrag());
    this.listen(this.root, "keydown", event => this.handleKey(event));
  }

  handleAction(event) {
    const target = event.target.closest("[data-action]");
    if (!target || !this.root.contains(target)) return;
    const action = target.dataset.action;
    const id = target.dataset.locationId;
    if (action === "select") this.selectLocation(id, true);
    else if (action === "favorite") void this.toggleFavorite(id ?? this.state.selectedId);
    else if (action === "fit") this.fit();
    else if (action === "zoom-in") this.zoom(1.35);
    else if (action === "zoom-out") this.zoom(1 / 1.35);
    else if (action === "place") this.beginPlacement();
    else if (action === "cancel-placement") this.cancelPlacement();
    else if (action === "clear-pin") void this.clearCustomPin();
    else if (action === "locate") this.locateSelected();
  }

  getMarkers(location) {
    const official = (location.mapMarkers ?? []).filter(isValidPin).map(marker => ({ ...marker, kind: "official" }));
    if (official.length) return official;
    const pin = this.customPins[location.id];
    return pin ? [{ ...pin, code: "◆", kind: "manual" }] : [];
  }

  matches(location) {
    if (this.state.district && location.district !== this.state.district) return false;
    if (this.state.placedOnly && this.getMarkers(location).length === 0) return false;
    if (this.state.favoritesOnly && !this.favoriteIds.has(location.id)) return false;
    const terms = normalizeSearch(this.state.query).trim().split(/\s+/).filter(Boolean);
    return terms.every(term => this.searchIndex.get(location.id).includes(term));
  }

  renderResults() {
    const active = document.activeElement;
    const activeContainer = active?.closest("[data-role=locations], [data-role=markers]");
    const restoreFocus = activeContainer && this.root.contains(active) && active.dataset.locationId
      ? { role: activeContainer.dataset.role, id: active.dataset.locationId, action: active.dataset.action, code: active.dataset.markerCode } : null;
    this.filteredLocations = this.locations.filter(location => this.matches(location));
    const list = document.createDocumentFragment();
    for (const location of this.filteredLocations) {
      const row = element("div", "nc-atlas__location-row");
      row.setAttribute("role", "listitem");
      row.classList.toggle("is-selected", this.state.selectedId === location.id);
      const button = element("button", "nc-atlas__location");
      button.type = "button";
      button.dataset.action = "select";
      button.dataset.locationId = location.id;
      button.setAttribute("aria-pressed", String(this.state.selectedId === location.id));
      button.append(element("span", "nc-atlas__location-name", location.name));
      const meta = element("span", "nc-atlas__location-meta");
      meta.append(element("span", "", location.district));
      const markers = this.getMarkers(location);
      if (markers.length) meta.append(element("span", `nc-atlas__location-code${markers[0].kind === "manual" ? " is-manual" : ""}`, markers.map(marker => marker.code).join(" · ")));
      button.append(meta);
      row.append(button);
      const favorite = element("button", "nc-atlas__favorite", this.favoriteIds.has(location.id) ? "★" : "☆");
      favorite.type = "button";
      favorite.dataset.action = "favorite";
      favorite.dataset.locationId = location.id;
      favorite.setAttribute("aria-pressed", String(this.favoriteIds.has(location.id)));
      favorite.setAttribute("aria-label", `${this.favoriteIds.has(location.id) ? "Убрать из избранного" : "В избранное"}: ${location.name}`);
      row.append(favorite);
      list.append(row);
    }
    if (!this.filteredLocations.length) list.append(element("p", "nc-atlas__no-results", "Места не найдены. Измените поиск или фильтры."));
    this.nodes.locations.replaceChildren(list);
    this.nodes["result-count"].textContent = `${this.filteredLocations.length} / ${this.locations.length}`;
    this.renderMarkers();
    if (restoreFocus) {
      const replacement = Array.from(this.nodes[restoreFocus.role].querySelectorAll("button")).find(button =>
        button.dataset.locationId === restoreFocus.id && button.dataset.action === restoreFocus.action
        && (!restoreFocus.code || button.dataset.markerCode === restoreFocus.code));
      replacement?.focus({ preventScroll: true });
    }
  }

  renderMarkers() {
    const fragment = document.createDocumentFragment();
    for (const location of this.filteredLocations) {
      for (const marker of this.getMarkers(location)) {
        const button = element("button", `nc-atlas__marker${marker.kind === "manual" ? " is-manual" : ""}`, marker.code);
        button.type = "button";
        button.dataset.action = "select";
        button.dataset.locationId = location.id;
        button.dataset.markerCode = marker.code;
        button.style.left = `${marker.x * 100}%`;
        button.style.top = `${marker.y * 100}%`;
        button.classList.toggle("is-selected", this.state.selectedId === location.id);
        button.setAttribute("aria-pressed", String(this.state.selectedId === location.id));
        button.setAttribute("aria-label", `${location.name}, ${marker.kind === "manual" ? "ваша метка" : `метка ${marker.code}`}`);
        button.title = `${marker.code} · ${location.name}`;
        fragment.append(button);
      }
    }
    this.nodes.markers.replaceChildren(fragment);
  }

  selectLocation(id, center = false) {
    if (!this.byId.has(id)) return;
    this.cancelPlacement();
    this.state.selectedId = id;
    this.renderResults();
    this.renderDetails();
    if (center) this.locateSelected();
    const location = this.byId.get(id);
    this.setStatus(`${location.name} · ${location.district}`);
  }

  renderDetails() {
    const location = this.byId.get(this.state.selectedId);
    if (!location) return;
    const fragment = document.createDocumentFragment();
    const header = element("div", "nc-atlas__detail-header");
    header.append(element("span", "nc-atlas__eyebrow", location.district));
    const heading = element("div", "nc-atlas__detail-title");
    heading.append(element("h2", "", location.name));
    const favorite = element("button", "nc-atlas__favorite nc-atlas__detail-favorite", this.favoriteIds.has(location.id) ? "★" : "☆");
    favorite.type = "button";
    favorite.dataset.action = "favorite";
    favorite.setAttribute("aria-label", this.favoriteIds.has(location.id) ? "Убрать из избранного" : "Добавить в избранное");
    favorite.setAttribute("aria-pressed", String(this.favoriteIds.has(location.id)));
    heading.append(favorite);
    header.append(heading);
    const markers = this.getMarkers(location);
    const badges = element("div", "nc-atlas__badges");
    badges.append(element("span", `nc-atlas__badge${markers[0]?.kind === "manual" ? " is-manual" : ""}`, markers.length ? (markers[0].kind === "manual" ? "Ваша метка" : `Карта: ${markers.map(marker => marker.code).join(", ")}`) : "Координаты не назначены"));
    if (location.originalMapReferences?.length) badges.append(element("span", "nc-atlas__badge", `Первая карта: ${location.originalMapReferences.map(reference => reference.number).join(", ")}`));
    header.append(badges);
    fragment.append(header);
    const actions = element("div", "nc-atlas__detail-actions");
    if (markers.length) actions.append(this.actionButton("locate", "Показать на карте", "fas fa-crosshairs"));
    if (!(location.mapMarkers ?? []).filter(isValidPin).length) actions.append(this.actionButton("place", this.customPins[location.id] ? "Переместить метку" : "Поставить метку", "fas fa-map-pin"));
    if (this.customPins[location.id] && !(location.mapMarkers ?? []).filter(isValidPin).length) actions.append(this.actionButton("clear-pin", "Убрать свою метку", "fas fa-trash-can"));
    fragment.append(actions);
    const description = element("div", "nc-atlas__description", location.description || "Описание для этой локации пока отсутствует в источнике.");
    fragment.append(description);
    if (location.aliases?.length) fragment.append(element("p", "nc-atlas__aliases", `Другие названия: ${location.aliases.join(" · ")}`));
    const citation = element("div", "nc-atlas__source");
    citation.append(element("span", "nc-atlas__eyebrow", "ИСТОЧНИК"));
    if (location.sourceCitation) citation.append(element("p", "", location.sourceCitation));
    const url = safeSourceUrl(location.sourceUrl);
    if (url) {
      const link = element("a", "nc-atlas__source-link", "Открыть полное описание в вики ↗");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      citation.append(link);
    }
    fragment.append(citation);
    this.nodes.detail.replaceChildren(fragment);
  }

  actionButton(action, text, icon) {
    const button = element("button", "nc-atlas__detail-action");
    button.type = "button";
    button.dataset.action = action;
    const glyph = element("i", icon);
    glyph.setAttribute("aria-hidden", "true");
    button.append(glyph, document.createTextNode(` ${text}`));
    return button;
  }

  updateSummary() {
    const placed = this.locations.filter(location => this.getMarkers(location).length).length;
    this.nodes.summary.textContent = `${this.locations.length} локаций · ${placed} на карте`;
  }

  async toggleFavorite(id) {
    if (!this.canWrite() || !this.byId.has(id) || this.favoriteSaving) return;
    const next = new Set(this.favoriteIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    this.favoriteSaving = true;
    try {
      await this.adapters.saveFavorites?.([...next]);
      if (this.destroyed) return;
      this.favoriteIds = next;
      this.renderResults();
      this.renderDetails();
      this.setStatus(next.has(id) ? "Место добавлено в избранное." : "Место убрано из избранного.");
    } catch {
      this.error("Не удалось сохранить избранное. Повторите действие.");
    } finally { this.favoriteSaving = false; }
  }

  canWrite() {
    if (this.adapters.isGM && !this.adapters.isGM()) {
      this.error("Изменения атласа доступны только Мастеру.");
      return false;
    }
    return true;
  }

  beginPlacement() {
    const location = this.byId.get(this.state.selectedId);
    if (!this.canWrite() || !location || (location.mapMarkers ?? []).filter(isValidPin).length || this.pinSaving) return;
    this.state.placement = true;
    this.nodes["placement-banner"].hidden = false;
    this.nodes.viewport.classList.add("is-placing");
    this.nodes.viewport.focus();
    this.setStatus(`Размещение: ${location.name}. Щёлкните по карте; Esc — отмена.`);
  }

  cancelPlacement() {
    this.state.placement = false;
    this.nodes["placement-banner"].hidden = true;
    this.nodes.viewport.classList.remove("is-placing");
    this.setStatus(DEFAULT_STATUS);
  }

  async placeSelected(x, y) {
    const id = this.state.selectedId;
    const location = this.byId.get(id);
    if (!this.canWrite() || !location || this.pinSaving || !isValidPin({ x, y })
      || (location.mapMarkers ?? []).filter(isValidPin).length) return;
    const next = { ...this.customPins, [id]: { x, y } };
    this.pinSaving = true;
    this.setStatus("Сохранение метки…");
    try {
      await this.adapters.saveCustomPins?.(next);
      if (this.destroyed) return;
      this.customPins = next;
      this.cancelPlacement();
      this.renderResults();
      this.renderDetails();
      this.updateSummary();
      this.setStatus("Ваша метка сохранена в этом браузере.");
    } catch {
      this.error("Не удалось сохранить метку. Щёлкните по карте, чтобы повторить.");
    } finally { this.pinSaving = false; }
  }

  async clearCustomPin() {
    const id = this.state.selectedId;
    if (!this.canWrite() || !this.customPins[id] || this.pinSaving) return;
    const next = { ...this.customPins };
    delete next[id];
    this.pinSaving = true;
    try {
      await this.adapters.saveCustomPins?.(next);
      if (this.destroyed) return;
      this.customPins = next;
      this.cancelPlacement();
      this.renderResults();
      this.renderDetails();
      this.updateSummary();
      this.setStatus("Ваша метка удалена. Её можно поставить снова.");
    } catch { this.error("Не удалось удалить метку. Повторите действие."); }
    finally { this.pinSaving = false; }
  }

  setStatus(message) {
    if (!this.destroyed) this.nodes.status.textContent = message;
  }

  error(message) {
    if (this.destroyed) return;
    this.setStatus(message);
    this.adapters.notify?.(message);
  }

  handleResize() {
    if (this.destroyed) return;
    const { clientWidth: width, clientHeight: height } = this.nodes.viewport;
    if (!width || !height) return;
    if (!this.userMoved) this.fit();
    else if (this.previousSize) {
      this.view.x += (width - this.previousSize.width) / 2;
      this.view.y += (height - this.previousSize.height) / 2;
      this.applyView();
    }
    this.previousSize = { width, height };
  }

  fit() {
    const viewport = this.nodes.viewport;
    if (!viewport.clientWidth || !viewport.clientHeight) return;
    this.view.scale = Math.min(viewport.clientWidth / this.dataset.map.width, viewport.clientHeight / this.dataset.map.height) * 0.96;
    this.view.x = (viewport.clientWidth - this.dataset.map.width * this.view.scale) / 2;
    this.view.y = (viewport.clientHeight - this.dataset.map.height * this.view.scale) / 2;
    this.userMoved = false;
    this.previousSize = { width: viewport.clientWidth, height: viewport.clientHeight };
    this.applyView();
  }

  zoom(factor, x = this.nodes.viewport.clientWidth / 2, y = this.nodes.viewport.clientHeight / 2) {
    const fit = Math.min(this.nodes.viewport.clientWidth / this.dataset.map.width, this.nodes.viewport.clientHeight / this.dataset.map.height) * 0.96;
    const nextScale = Math.max(fit * 0.65, Math.min(Math.max(4, fit * 20), this.view.scale * factor));
    const ratio = nextScale / this.view.scale;
    this.view.x = x - (x - this.view.x) * ratio;
    this.view.y = y - (y - this.view.y) * ratio;
    this.view.scale = nextScale;
    this.userMoved = true;
    this.applyView();
  }

  applyView() {
    const viewport = this.nodes.viewport;
    const width = this.dataset.map.width * this.view.scale;
    const height = this.dataset.map.height * this.view.scale;
    this.view.x = width < viewport.clientWidth ? (viewport.clientWidth - width) / 2 : Math.min(32, Math.max(viewport.clientWidth - width - 32, this.view.x));
    this.view.y = height < viewport.clientHeight ? (viewport.clientHeight - height) / 2 : Math.min(32, Math.max(viewport.clientHeight - height - 32, this.view.y));
    this.nodes.stage.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.scale})`;
    this.nodes.stage.style.setProperty("--nc-pin-scale", String(1 / this.view.scale));
    this.nodes.zoom.textContent = `${Math.round(this.view.scale * 100)}%`;
  }

  locateSelected() {
    const location = this.byId.get(this.state.selectedId);
    const marker = location && this.getMarkers(location)[0];
    if (!marker) return;
    this.view.scale = Math.max(this.view.scale, 1.05);
    this.view.x = this.nodes.viewport.clientWidth / 2 - marker.x * this.dataset.map.width * this.view.scale;
    this.view.y = this.nodes.viewport.clientHeight / 2 - marker.y * this.dataset.map.height * this.view.scale;
    this.userMoved = true;
    this.applyView();
  }

  pointerDown(event) {
    if (event.button !== 0 || event.target.closest("button, a")) return;
    this.nodes.viewport.focus({ preventScroll: true });
    this.drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: this.view.x, y: this.view.y, moved: false };
    this.nodes.viewport.setPointerCapture(event.pointerId);
    if (!this.state.placement) this.nodes.viewport.classList.add("is-dragging");
  }

  pointerMove(event) {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const dx = event.clientX - this.drag.startX;
    const dy = event.clientY - this.drag.startY;
    if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
    if (this.drag.moved) {
      this.view.x = this.drag.x + dx;
      this.view.y = this.drag.y + dy;
      this.userMoved = true;
      this.applyView();
    }
  }

  pointerUp(event) {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const moved = this.drag.moved;
    this.cancelDrag();
    if (this.state.placement && !moved) {
      const rect = this.nodes.viewport.getBoundingClientRect();
      const x = (event.clientX - rect.left - this.view.x) / (this.view.scale * this.dataset.map.width);
      const y = (event.clientY - rect.top - this.view.y) / (this.view.scale * this.dataset.map.height);
      if (isValidPin({ x, y })) void this.placeSelected(x, y);
      else this.setStatus("Щёлкните внутри изображения карты, чтобы поставить метку.");
    }
  }

  cancelDrag() {
    if (this.drag && this.nodes.viewport.hasPointerCapture(this.drag.id)) this.nodes.viewport.releasePointerCapture(this.drag.id);
    this.drag = null;
    this.nodes.viewport.classList.remove("is-dragging");
  }

  handleKey(event) {
    if (event.key === "Escape" && this.state.placement) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelPlacement();
      return;
    }
    if (event.target !== this.nodes.viewport) return;
    if (["+", "="].includes(event.key)) this.zoom(1.35);
    else if (event.key === "-") this.zoom(1 / 1.35);
    else if (["f", "F", "а", "А", "0"].includes(event.key)) this.fit();
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const directions = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
      const [dx, dy] = directions[event.key];
      this.view.x += dx;
      this.view.y += dy;
      this.userMoved = true;
      this.applyView();
    } else return;
    event.preventDefault();
  }

  /** Snapshot useful to integrations and browser tests; mutation stays behind the controller methods. */
  getState() {
    return { ...this.state, view: { ...this.view }, favorites: [...this.favoriteIds], customPins: structuredClone(this.customPins), filteredIds: this.filteredLocations.map(location => location.id) };
  }

  destroy() {
    this.cancelDrag();
    this.destroyed = true;
    this.abort.abort();
    this.resizeObserver.disconnect();
  }
}
