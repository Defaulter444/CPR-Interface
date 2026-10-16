import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { AtlasMapController } from '../scripts/map-controller.js';
import { emptyCity, applyCityOperation, projectCity } from '../scripts/city-model.js';

const source = JSON.parse(readFileSync(new URL('../data/locations.json', import.meta.url), 'utf8'));
const byCode = (data, code) => data.locations.find(p => p.mapMarkers.some(m => m.code === code));

class NodeStub {
  constructor(role = '') {
    this.dataset = { role }; this.children = []; this.attributes = {}; this.value = '';
    this.className = ''; this.style = { setProperty() {} };
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this[name] ?? this.attributes[name]; }
}

// Rendering is stubbed only where it requires a live DOM. Indexing, filtering,
// selection reveal, projection and camera movement execute production methods.
class Controller extends AtlasMapController {
  listen() {}
  bindEvents() {}
  populateDistricts() { this.nodes.district.options = [{ value: '' }, ...this.locations.map(p => ({ value: p.district }))]; }
  renderResults() { this.filteredLocations = this.locations.filter(p => this.matches(p)); }
  renderDetails() {}
  updateSummary() {}
}

function fixture(t, data = source) {
  for (const [key, value] of Object.entries({
    ResizeObserver: class { observe() {} disconnect() {} },
    document: { createElement: () => new NodeStub(), createDocumentFragment: () => new NodeStub(), createTextNode: text => ({ textContent: text }) }
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => old ? Object.defineProperty(globalThis, key, old) : delete globalThis[key]);
  }
  const nodes = Object.fromEntries(['stage', 'map-image', 'map-error', 'viewport', 'zoom', 'district', 'search', 'favorites-only', 'placed-only', 'markers', 'detail', 'placement-banner', 'status']
    .map(role => [role, new NodeStub(role)]));
  Object.assign(nodes.viewport, { clientWidth: 682, clientHeight: 620 });
  const controller = new Controller({ querySelectorAll: () => Object.values(nodes) }, data);
  t.after(() => controller.destroy());
  return controller;
}

function search(controller, query) {
  controller.state.query = query;
  controller.nodes.search.value = query;
  controller.renderResults();
  return controller.filteredLocations.map(p => p.id);
}

function descendants(node) {
  return [node, ...(node.children ?? []).flatMap(descendants)];
}

test('initial search and a city refresh use the same reference fields and official codes', t => {
  const c = fixture(t);
  const queries = ['Xanadu', 'аренда', 'F4', '75'];
  const before = new Map(queries.map(q => [q, search(c, q)]));
  assert.equal(before.get('Xanadu').length, 2);
  assert.equal(before.get('аренда').length, 7);
  assert.ok(before.get('F4').includes(byCode(source, 'F4').id));
  c.replaceDataset(structuredClone(source));
  for (const query of queries) assert.deepEqual(search(c, query), before.get(query), query);
});

test('reveal clears conflicting filters and restores the selected marker while preserving placed-only', t => {
  const c = fixture(t), target = byCode(source, 'B1');
  c.state.selectedId = target.id;
  c.state.district = c.nodes.district.value = 'Другой район';
  c.state.favoritesOnly = c.nodes['favorites-only'].checked = true;
  c.state.placedOnly = c.nodes['placed-only'].checked = true;
  search(c, 'F4');
  assert.ok(!c.filteredLocations.some(p => p.id === target.id));
  c.locateSelected();
  assert.ok(c.filteredLocations.some(p => p.id === target.id));
  assert.equal(c.state.query, ''); assert.equal(c.nodes.search.value, '');
  assert.equal(c.state.district, ''); assert.equal(c.nodes.district.value, '');
  assert.equal(c.state.favoritesOnly, false); assert.equal(c.nodes['favorites-only'].checked, false);
  assert.equal(c.state.placedOnly, true); assert.equal(c.nodes['placed-only'].checked, true);
  assert.equal(c.state.selectedId, target.id);
});

test('reveal retains filters that already include the selected place', t => {
  const c = fixture(t), target = byCode(source, 'B1');
  c.state.selectedId = target.id; c.favoriteIds.add(target.id);
  c.state.district = c.nodes.district.value = target.district;
  c.state.favoritesOnly = c.nodes['favorites-only'].checked = true;
  c.state.placedOnly = c.nodes['placed-only'].checked = true;
  search(c, target.name);
  const filters = { query: c.state.query, district: c.state.district, favoritesOnly: true, placedOnly: true };
  c.locateSelected();
  for (const [key, value] of Object.entries(filters)) assert.equal(c.state[key], value);
  assert.deepEqual(c.filteredLocations.map(p => p.id), [target.id]);
});

test('an unlocated selection does not clear filters or move the camera', t => {
  const c = fixture(t), target = source.locations.find(p => !p.mapMarkers.length);
  c.state.selectedId = target.id; search(c, 'F4');
  const before = structuredClone(c.view);
  c.locateSelected();
  assert.equal(c.state.query, 'F4'); assert.deepEqual(c.view, before);
});

test('a moved official marker stays searchable by its code and is labelled as a GM position', t => {
  const target = byCode(source, 'F4');
  const state = applyCityOperation(emptyCity(), 'override.save', { id: target.id, x: 0.7, y: 0.4 }, {
    isGM: true, baseIds: new Set(source.locations.map(p => p.id))
  });
  const projected = projectCity(source, state), c = fixture(t, projected);
  assert.ok(search(c, 'F4').includes(target.id));
  c.state.selectedId = target.id;
  AtlasMapController.prototype.renderMarkers.call(c);
  const marker = descendants(c.nodes.markers).find(n => n.dataset?.markerCode === 'F4');
  assert.equal(marker.textContent, 'F4');
  assert.equal(marker.style.left, '70%'); assert.equal(marker.style.top, '40%');
  assert.match(marker.className, /is-manual/);
  assert.match(marker.title, /позиция Мастера/);
  assert.match(marker.attributes['aria-label'], /позиция Мастера/);
  AtlasMapController.prototype.renderDetails.call(c);
  const badge = descendants(c.nodes.detail).find(n => n.className?.split(' ').includes('nc-atlas__badge'));
  assert.equal(badge.textContent, `${target.bookReference ? 'Атлас 2025' : 'Карта'}: F4 · позиция Мастера`);
  c.replaceDataset(projectCity(source, state));
  assert.ok(search(c, 'F4').includes(target.id));
  assert.equal(target.mapMarkers[0].kind, 'official');
  assert.notEqual(target.mapMarkers[0].x, 0.7);
});

test('book and atlas numbers remain distinct, with only the explicit book number key added to search', t => {
  const location = {
    id: 'university', name: 'University', description: 'A campus', district: 'University District',
    mapMarkers: [{ code: 'F4', x: 0.2, y: 0.3, kind: 'official' }],
    bookReference: {
      title: 'Night City 2045', mapNumber: '11', mapPage: 105, descriptionPage: 108,
      numberKey: 'F11', note: 'Distinct-book-note: <em>numbering differs</em>'
    }
  };
  const data = { map: source.map, locations: [location] }, c = fixture(t, data);
  assert.deepEqual(search(c, 'F4'), [location.id]);
  assert.deepEqual(search(c, 'F11'), [location.id]);
  for (const query of ['105', '108', 'Distinct-book-note', 'Night City 2045']) assert.deepEqual(search(c, query), []);
  c.state.selectedId = location.id;
  AtlasMapController.prototype.renderDetails.call(c);
  const all = descendants(c.nodes.detail);
  const badges = all.filter(n => n.className?.split(' ').includes('nc-atlas__badge')).map(n => n.textContent);
  assert.deepEqual(badges, ['Атлас 2025: F4', 'Книга 2045: №11 · карта с.105 · описание с.108']);
  assert.ok(all.some(n => n.textContent === location.bookReference.note));
  assert.equal(location.mapMarkers[0].code, 'F4');
  c.replaceDataset(structuredClone(data));
  assert.deepEqual(search(c, 'F11'), [location.id]);
  assert.deepEqual(search(c, '105'), []);
});

test('book references are optional and never synthesize a map marker for an unlocated place', t => {
  const location = {
    id: 'unlocated', name: 'Library', mapMarkers: [],
    bookReference: { title: 'Night City 2045', mapNumber: '11', mapPage: 105 }
  };
  const c = fixture(t, { map: source.map, locations: [location] });
  c.state.selectedId = location.id;
  AtlasMapController.prototype.renderDetails.call(c);
  const badges = descendants(c.nodes.detail).filter(n => n.className?.split(' ').includes('nc-atlas__badge')).map(n => n.textContent);
  assert.deepEqual(badges, ['Координаты не назначены', 'Книга 2045: №11 · карта с.105']);
  assert.deepEqual(c.getMarkers(location), []);
  assert.deepEqual(search(c, 'F11'), []);
});

test('coordinate provenance distinguishes a book position from an approximate Atlas area', t => {
  const c = fixture(t, { map: source.map, locations: [] });
  for (const [coordinateSource, label] of [
    ['book-2026', 'Положение: карта книги 2045'],
    ['atlas-2025-area', 'Общая территория: ориентир Атласа 2025']
  ]) {
    const location = {
      id: 'place', name: 'Place',
      mapMarkers: [{ code: 'F4', x: 0.2, y: 0.3, kind: 'official', coordinateSource }]
    };
    c.replaceDataset({ map: source.map, locations: [location] });
    c.state.selectedId = location.id;
    AtlasMapController.prototype.renderDetails.call(c);
    const line = descendants(c.nodes.detail).find(n => n.className?.split(' ').includes('nc-atlas__position-source'));
    assert.equal(line.textContent, label);
    assert.equal(c.getMarkers(location)[0].code, 'F4');
  }
});

test('a GM override never claims that its new position came from the book or the original area', t => {
  const c = fixture(t, { map: source.map, locations: [] });
  for (const coordinateSource of ['book-2026', 'atlas-2025-area']) {
    const location = {
      id: 'place', name: 'Place',
      mapMarkers: [{ code: 'F4', x: 0.2, y: 0.3, kind: 'official', coordinateSource }]
    };
    const state = applyCityOperation(emptyCity(), 'override.save', { id: location.id, x: 0.7, y: 0.4 }, { isGM: true, baseIds: new Set([location.id]) });
    c.replaceDataset(projectCity({ map: source.map, locations: [location] }, state));
    c.state.selectedId = location.id;
    AtlasMapController.prototype.renderDetails.call(c);
    const all = descendants(c.nodes.detail);
    assert.ok(all.some(n => n.textContent === 'Карта: F4 · позиция Мастера'));
    assert.ok(!all.some(n => n.className?.split(' ').includes('nc-atlas__position-source')));
    assert.equal(c.getMarkers(c.byId.get(location.id))[0].coordinateSource, coordinateSource);
  }
});
