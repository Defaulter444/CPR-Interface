import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyCity, validateCity, applyCityOperation, projectCity, exportCity, importCity, safeImage } from '../scripts/city-model.js';
import { createCityStore } from '../scripts/city-store.js';
import { advanceTravelClock } from '../scripts/city-integrations.js';
const baseIds = new Set(['wiki-one']);
const ctx = { isGM: true, baseIds, newId: 'custom-one' };
const custom = { name: 'Клиника', x: 0.2, y: 0.6, description: '<b>Текст</b>' };
const apply = (state, op, payload, context = ctx) => applyCityOperation(state, op, payload, context);

test('public city round trips without mutating inputs or including unrecognized secret data', () => {
  const before = emptyCity(), state = apply(before, 'place.save', custom);
  assert.equal(before.revision, 0); assert.equal(Object.keys(before.places).length, 0);
  assert.equal(state.places['custom-one'].name, 'Клиника');
  assert.deepEqual(importCity(exportCity(state), baseIds), state);
  assert.throws(() => validateCity({ ...state, privateMessages: [] }), /неизвестное поле/);
  assert.throws(() => importCity(JSON.stringify({ format: 'night-city-map', version: 1, city: state })), /не экспорт/);
});
test('players cannot mutate any public city operation', () => {
  for (const op of ['place.save', 'crew.set', 'route.publish', 'import', 'config.set', 'roads.set']) {
    assert.throws(() => apply(emptyCity(), op, {}, { isGM: false }), /только Мастер/);
  }
});
test('strict schema rejects pollution, coerced coordinates, oversized imports and unknown references', () => {
  const polluted = JSON.parse(JSON.stringify(emptyCity()).replace('"places":{}', '"places":{"__proto__":{"id":"__proto__","name":"x","x":0,"y":0}}'));
  assert.throws(() => validateCity(polluted), /идентификатор/);
  for (const x of ['0.5', NaN, Infinity, -0.1, 1.1, null]) assert.throws(() => apply(emptyCity(), 'place.save', { ...custom, x }));
  assert.throws(() => apply(emptyCity(), 'override.save', { id: 'missing', name: 'x' }), /отсутствует/);
  assert.throws(() => importCity(' '.repeat(2 * 1024 * 1024 + 1)), /2 МБ/);
  assert.throws(() => apply(emptyCity(), 'place.save', { ...custom, id: 'wiki-one' }), /custom/);
});
test('protected place cannot be deleted or replaced by import until explicitly unprotected', () => {
  const state = apply(emptyCity(), 'place.save', { ...custom, protected: true });
  assert.throws(() => apply(state, 'place.remove', { id: 'custom-one' }), /защиту/);
  assert.throws(() => apply(state, 'import', { state: emptyCity() }), /защищённое/);
  const unlocked = apply(state, 'place.save', { ...state.places['custom-one'], protected: false });
  assert.equal(Object.keys(apply(unlocked, 'place.remove', { id: 'custom-one' }).places).length, 0);
});
test('dataset projection preserves reference records and separates campaign coordinates', () => {
  const original = { id: 'wiki-one', name: 'Original', description: 'full text', mapMarkers: [{ code: 'A1', x: 0.1, y: 0.2 }] };
  const data = { map: { width: 1200, height: 1855 }, locations: [original] };
  let state = apply(emptyCity(), 'override.save', { id: 'wiki-one', name: 'Session name', x: 0.4, y: 0.5 });
  state = apply(state, 'place.save', custom);
  const projected = projectCity(data, state);
  assert.equal(projected.locations.length, 2);
  assert.equal(projected.locations[0].description, 'full text');
  assert.equal(projected.locations[0].mapMarkers[0].kind, 'campaign');
  assert.equal(original.name, 'Original'); assert.equal(original.mapMarkers[0].x, 0.1);
  const hidden = apply(state, 'override.save', { id: 'wiki-one', hidden: true });
  assert.equal(projectCity(data, hidden).locations.length, 1);
  assert.equal(projectCity(data, apply(hidden, 'override.reset', { id: 'wiki-one' })).locations[0], original);
});
test('image paths reject executable URLs and traversal; text stays plain data', () => {
  for (const image of ['javascript:alert(1)', 'data:image/svg+xml,xxx', '../secret', 'worlds/../secret', '//example.org/x', 'https://user:pass@example.org/x']) assert.throws(() => safeImage(image));
  assert.equal(safeImage('worlds/test/picture.webp'), 'worlds/test/picture.webp');
  assert.equal(safeImage('https://example.org/x.png'), 'https://example.org/x.png');
});
test('invalid topology, oversized collections, zones outside map and invalid speeds reject atomically', () => {
  const before = emptyCity();
  assert.throws(() => apply(before, 'roads.set', { roads: Array(1001).fill({}) }));
  assert.throws(() => apply(before, 'roads.set', { roads: [{ id: 'zero', a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }] }), /разных/);
  assert.throws(() => apply(before, 'zones.set', { zones: [{ id: 'z', name: 'Z', x: 0.9, y: 0.9, width: 0.2, height: 0.2, threat: 'hot' }] }));
  assert.throws(() => apply(before, 'config.set', { config: { widthKm: 20, speeds: { walk: 0, bike: 18, car: 35, av: 100 } } }));
  assert.deepEqual(before, emptyCity());
});
test('serialized store re-reads fresh state, retains both edits and recovers after failure', async () => {
  let state = emptyCity(), writes = 0;
  const store = createCityStore({ read: () => state, write: async next => { await new Promise(r => setTimeout(r, 3)); state = next; writes++; },
    authorize: () => {}, baseIds, newId: () => 'custom-one' });
  await Promise.all([store.execute('crew.set', { point: { x: 0.1, y: 0.2 } }), store.execute('place.save', custom)]);
  assert.equal(state.revision, 2); assert.equal(state.crew.x, 0.1); assert.ok(state.places['custom-one']);
  await assert.rejects(store.execute('crew.set', { point: null }, 0), /изменились/);
  assert.equal(writes, 2);
  await store.execute('crew.set', { point: null }); assert.equal(state.revision, 3);
});
test('queued authorization is rechecked when the operation runs', async () => {
  let state = emptyCity(), authorized = true;
  const store = createCityStore({ read: () => state, write: async next => { state = next; authorized = false; },
    authorize: () => { if (!authorized) throw Error('denied'); }, baseIds, newId: () => 'custom-one' });
  const results = await Promise.allSettled([store.execute('crew.set', { point: null }), store.execute('place.save', custom)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(state.revision, 1);
});
test('travel advances one clock only and never falls back after calendar rejection', async () => {
  let calendars = 0, worlds = 0;
  const world = { advance: async seconds => { assert.equal(seconds, 60); worlds++; } };
  await advanceTravelClock(60, { calendar: { changeDate: async () => { calendars++; return true; } }, world });
  assert.equal(calendars, 1); assert.equal(worlds, 0);
  await assert.rejects(advanceTravelClock(60, { calendar: { changeDate: async () => false }, world }), /отклонил/);
  assert.equal(worlds, 0);
  await advanceTravelClock(60, { world }); assert.equal(worlds, 1);
  await assert.rejects(advanceTravelClock(-10, { world })); assert.equal(worlds, 1);
});
