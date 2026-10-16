import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoute, routeMetrics, shortestRoadRoute } from '../scripts/routes.js';

const p = (x, y) => ({ x, y });
const edge = (id, a, b) => ({ id, a, b });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
const zone = overrides => ({ id: 'restricted', name: 'Условная опасная зона', x: .4, y: .4, width: .2, height: .2, threat: 'combat', ...overrides });

test('normalization preserves valid geometry without retaining caller objects or metadata', () => {
  const source = Object.freeze([Object.freeze({ x: -0, y: .3, privateNote: 'local' }), Object.freeze(p(1, 1))]);
  const result = normalizeRoute(source);
  assert.deepEqual(result, [p(0, .3), p(1, 1)]);
  result[0].x = .5;
  assert.equal(source[0].x, -0);
  assert.deepEqual(normalizeRoute([]), []);
  assert.deepEqual(normalizeRoute([p(.2, .4)]), [p(.2, .4)]);
});

test('route validation rejects nonfinite, coerced, out-of-map and malformed points', () => {
  for (const bad of [p(NaN, 0), p(Infinity, 0), p(0, -Infinity), p('0.5', 0), p(null, 0), p(false, 0), p(-.01, .2), p(.3, 1.01), {}, null, [0, 0]]) {
    assert.throws(() => normalizeRoute([bad]));
  }
  for (const bad of [null, {}, '0,0']) assert.throws(() => normalizeRoute(bad));
  assert.throws(() => normalizeRoute(new Array(2)), /Точка/);
  assert.throws(() => normalizeRoute(Array.from({ length: 65 }, () => p(.1, .1))), /64/);
  assert.equal(normalizeRoute(Array.from({ length: 65 }, () => p(.1, .1)), 65).length, 65);
  for (const max of [0, 1.5, 1004, Infinity, '64']) assert.throws(() => normalizeRoute([], max));
});

test('distance follows the full polyline and physical map aspect, not a straight shortcut', () => {
  const route = [p(0, 0), p(1, 0), p(1, 1)];
  const result = routeMetrics(route);
  near(result.distanceKm, 20 + 20 * 1855 / 1200);
  near(result.minutes, result.distanceKm / 5 * 60);
  assert.equal(result.estimated, true);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.distanceKm > routeMetrics([route[0], route[2]]).distanceKm);
  near(routeMetrics([p(0, 0), p(1, 0)]).distanceKm, 20);
});

test('walk, bike, car and AV use explicit editable estimate speeds without changing geometry', () => {
  const route = [p(.1, .4), p(.6, .4)];
  for (const [mode, speed] of Object.entries({ walk: 5, bike: 18, car: 35, av: 100 })) {
    const result = routeMetrics(route, { mode });
    near(result.distanceKm, 10);
    near(result.minutes, 10 / speed * 60);
  }
  near(routeMetrics(route, { mode: 'car', speeds: { car: 20 } }).minutes, 30);
  near(routeMetrics(route, { widthKm: 10 }).distanceKm, 5);
  near(routeMetrics([p(0, 0), p(0, 1)], { mapWidth: 1, mapHeight: 1 }).distanceKm, 20);
});

test('empty, one-point and repeated-point drafts have zero length and time', () => {
  for (const route of [[], [p(.2, .3)], [p(.2, .3), p(.2, .3)]]) {
    assert.deepEqual(routeMetrics(route), { distanceKm: 0, minutes: 0, warnings: [], estimated: true });
  }
});

test('bad calibration, speed and mode fail instead of silently clamping estimates', () => {
  for (const options of [null, [], { widthKm: 0 }, { widthKm: '20' }, { mapWidth: -1 }, { mapHeight: Infinity }, { mapWidth: Number.MIN_VALUE, mapHeight: Number.MAX_VALUE }, { mode: 'teleport' }, { mode: 'constructor' }, { speeds: { car: 0 } }, { speeds: { av: NaN } }, { speeds: { boat: 10 } }, { speeds: [] }]) {
    assert.throws(() => routeMetrics([p(0, 0), p(1, 1)], options));
  }
  assert.throws(() => routeMetrics([p(0, 0), p(1, 1)], { widthKm: Number.MAX_VALUE }));
  for (const key of ['widthKm', 'mapWidth', 'mapHeight', 'mode', 'speeds', 'zones']) {
    assert.throws(() => routeMetrics([], { [key]: null }), key);
  }
});

test('a zone crossed between two outside endpoints produces one warning', () => {
  const result = routeMetrics([p(0, .5), p(1, .5), p(0, .5)], { zones: [zone()] });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Условная опасная зона/);
});

test('zone geometry detects boundary contact and diagonal crossing, with no bounding-box false positive', () => {
  assert.equal(routeMetrics([p(0, .4), p(1, .4)], { zones: [zone()] }).warnings.length, 1);
  assert.equal(routeMetrics([p(0, 0), p(1, 1)], { zones: [zone()] }).warnings.length, 1);
  assert.equal(routeMetrics([p(.5, .5), p(.8, .8)], { zones: [zone()] }).warnings.length, 1);
  assert.equal(routeMetrics([p(.1, .5), p(.5, .1)], { zones: [zone()] }).warnings.length, 0);
  assert.equal(routeMetrics([p(0, .399), p(1, .399)], { zones: [zone()] }).warnings.length, 0);
});

test('safe annotations do not warn; each intersected threat warns without changing speed', () => {
  const route = [p(0, .5), p(1, .5)];
  const zones = ['safe', 'moderate', 'combat', 'hot'].map(threat => zone({ id: threat, threat }));
  const result = routeMetrics(route, { zones, mode: 'av' });
  assert.equal(result.warnings.length, 3);
  near(result.minutes, 12);
  assert.equal(result.estimated, true);
});

test('zones require bounded rectangles, unique IDs and known threat annotations', () => {
  for (const bad of [zone({ width: 0 }), zone({ height: NaN }), zone({ x: .9 }), zone({ threat: 'deadly' }), zone({ id: '' }), zone({ name: '' }), zone({ width: '0.2' })]) {
    assert.throws(() => routeMetrics([], { zones: [bad] }));
  }
  assert.throws(() => routeMetrics([], { zones: [zone(), zone()] }));
  assert.throws(() => routeMetrics([], { zones: new Array(2) }));
  assert.throws(() => routeMetrics([], { zones: Array.from({ length: 257 }, (_, i) => zone({ id: `zone-${i}` })) }));
});

test('Dijkstra selects the shorter road path and does not mutate its graph', () => {
  const a = p(.1, .2), b = p(.4, .2), c = p(.7, .2), detour = p(.4, .8);
  const roads = [edge('ad', a, detour), edge('dc', detour, c), edge('ab', a, b), edge('bc', b, c)];
  const before = structuredClone(roads);
  const result = shortestRoadRoute(a, c, roads);
  assert.equal(result.reason, null);
  assert.deepEqual(result.points, [a, b, c]);
  assert.deepEqual(result.connectorSegments, []);
  assert.deepEqual(roads, before);
  result.points[1].x = .9;
  assert.equal(roads[2].b.x, .4);
});

test('start and end connectors are explicitly identified separately from road segments', () => {
  const a = p(.2, .2), b = p(.8, .2), start = p(.1, .2), end = p(.9, .2);
  const result = shortestRoadRoute(start, end, [edge('road', a, b)]);
  assert.deepEqual(result, { points: [start, a, b, end], reason: null, connectorSegments: [0, 2] });
  const exactStart = shortestRoadRoute(a, end, [edge('road', a, b)]);
  assert.deepEqual(exactStart.connectorSegments, [1]);
  assert.deepEqual(shortestRoadRoute(a, a, [edge('road', a, b)]), { points: [a], reason: null, connectorSegments: [] });
  assert.deepEqual(shortestRoadRoute(start, start, [edge('road', a, b)]), { points: [start], reason: null, connectorSegments: [] });
});

test('an empty or disconnected road network never invents a direct street route', () => {
  const a = p(.1, .2), b = p(.3, .2), c = p(.7, .2), d = p(.9, .2);
  for (const roads of [[], [edge('west-bank', a, b), edge('east-bank', c, d)]]) {
    const result = shortestRoadRoute(a, d, roads);
    assert.deepEqual(result.points, []);
    assert.deepEqual(result.connectorSegments, []);
    assert.ok(result.reason);
  }
});

test('geometric crossings create no implicit junction or bridge', () => {
  const a = p(.1, .5), b = p(.9, .5), c = p(.5, .1), d = p(.5, .9), junction = p(.5, .5);
  const crossed = [edge('horizontal', a, b), edge('vertical', c, d)];
  assert.deepEqual(shortestRoadRoute(a, d, crossed).points, []);
  const joined = [edge('west', a, junction), edge('east', junction, b), edge('north', c, junction), edge('south', junction, d)];
  assert.deepEqual(shortestRoadRoute(a, d, joined).points, [a, junction, d]);
});

test('road routing follows the authored detour around a gap instead of crossing it', () => {
  const a = p(.1, .1), b = p(.1, .9), c = p(.9, .9), d = p(.9, .1);
  const result = shortestRoadRoute(a, d, [edge('west', a, b), edge('bridge', b, c), edge('east', c, d)], { mapWidth: 1, mapHeight: 1 });
  assert.deepEqual(result.points, [a, b, c, d]);
  near(routeMetrics(result.points, { widthKm: 10, mapWidth: 1, mapHeight: 1 }).distanceKm, 24);
});

test('nearest-node snapping uses the configured map aspect', () => {
  const start = p(.5, .5), a = p(.6, .5), b = p(.5, .55), end = p(.9, .9);
  const roads = [edge('via-a', a, end), edge('via-b', b, end)];
  assert.deepEqual(shortestRoadRoute(start, end, roads, { mapWidth: 1, mapHeight: 1 }).points[1], b);
  assert.deepEqual(shortestRoadRoute(start, end, roads, { mapWidth: 1, mapHeight: 3 }).points[1], a);
});

test('invalid road endpoints, duplicate IDs, zero-length edges and oversized graphs are rejected', () => {
  const valid = edge('road', p(0, 0), p(1, 1));
  for (const roads of [null, {}, [edge('', p(0, 0), p(1, 1))], [valid, valid], [edge('zero', p(0, 0), p(0, 0))], [edge('bad', p(0, 0), p(Infinity, .5))], Array.from({ length: 1001 }, (_, i) => edge(`road-${i}`, p(0, 0), p(1, 1)))]) {
    assert.throws(() => shortestRoadRoute(p(0, 0), p(1, 1), roads));
  }
  assert.throws(() => shortestRoadRoute(p('0', 0), p(1, 1), [valid]));
});

test('a bounded long graph remains measurable beyond the manual draft limit', () => {
  const roads = Array.from({ length: 1000 }, (_, i) => edge(`road-${i}`, p(i / 1000, .5), p((i + 1) / 1000, .5)));
  const result = shortestRoadRoute(p(0, .4), p(1, .6), roads, { mapWidth: 1, mapHeight: 1 });
  assert.equal(result.points.length, 1003);
  assert.deepEqual(result.connectorSegments, [0, 1001]);
  near(routeMetrics(result.points, { widthKm: 10, mapWidth: 1, mapHeight: 1 }).distanceKm, 12);
  assert.throws(() => normalizeRoute(result.points), /64/);
});
