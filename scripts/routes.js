/** Pure estimates for a GM-authored map and road graph. No Foundry state or core travel rules. */
const MAX_ROADS = 1000;
const MAX_PATH_POINTS = MAX_ROADS + 3;
const MAX_ZONES = 256;
const DEFAULT_SPEEDS = Object.freeze({ walk: 5, bike: 18, car: 35, av: 100 });
const THREATS = Object.freeze({ safe: '', moderate: 'умеренная', combat: 'боевая', hot: 'высокая' });
const EPSILON = 1e-12;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label}: ожидается объект.`);
  return value;
}
function finite(value, label, { positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new RangeError(`${label}: ожидается ${positive ? 'положительное ' : ''}конечное число.`);
  }
  return value;
}
function point(value, label) {
  record(value, label);
  const x = finite(value.x, `${label}.x`), y = finite(value.y, `${label}.y`);
  if (x < 0 || x > 1 || y < 0 || y > 1) throw new RangeError(`${label}: координаты должны быть от 0 до 1.`);
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}
function calibration(options) {
  record(options, 'Настройки');
  const mapWidth = finite(options.mapWidth === undefined ? 1200 : options.mapWidth, 'Ширина карты', { positive: true });
  const mapHeight = finite(options.mapHeight === undefined ? 1855 : options.mapHeight, 'Высота карты', { positive: true });
  const aspect = finite(mapHeight / mapWidth, 'Соотношение сторон', { positive: true });
  return { aspect };
}
const samePoint = (a, b) => a.x === b.x && a.y === b.y;
const keyOf = p => `${p.x},${p.y}`;
const distance = (a, b, aspect) => Math.hypot(a.x - b.x, (a.y - b.y) * aspect);

/** Manual drafts default to 64 points; graph results may explicitly allow up to 1003. */
export function normalizeRoute(points, max = 64) {
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_PATH_POINTS) {
    throw new RangeError(`Лимит точек должен быть целым числом от 1 до ${MAX_PATH_POINTS}.`);
  }
  if (!Array.isArray(points)) throw new TypeError('Маршрут должен быть массивом точек.');
  if (points.length > max) throw new RangeError(`В маршруте допускается не больше ${max} точек.`);
  return Array.from(points, (value, index) => point(value, `Точка ${index + 1}`));
}

function normalizeZones(zones) {
  if (!Array.isArray(zones) || zones.length > MAX_ZONES) throw new RangeError(`Допускается массив не более ${MAX_ZONES} зон.`);
  const ids = new Set();
  return Array.from(zones, (value, index) => {
    const label = `Зона ${index + 1}`;
    record(value, label);
    if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 128 || ids.has(value.id)) {
      throw new TypeError(`${label}: нужен уникальный непустой id длиной не больше 128 символов.`);
    }
    ids.add(value.id);
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160) {
      throw new TypeError(`${label}: нужно название длиной от 1 до 160 символов.`);
    }
    const origin = point(value, label);
    const width = finite(value.width, `${label}.width`, { positive: true });
    const height = finite(value.height, `${label}.height`, { positive: true });
    if (width > 1 || height > 1 || origin.x + width > 1 + EPSILON || origin.y + height > 1 + EPSILON) {
      throw new RangeError(`${label}: прямоугольник должен находиться в пределах карты.`);
    }
    if (!Object.hasOwn(THREATS, value.threat)) throw new TypeError(`${label}: неизвестная отметка угрозы.`);
    return { id: value.id, name: value.name.trim(), ...origin, width, height, threat: value.threat };
  });
}

/** Slab clipping includes boundary contact and segments whose endpoints both lie outside. */
function intersects(a, b, zone) {
  let entering = 0, leaving = 1;
  for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
    const delta = b[axis] - a[axis], lower = zone[axis], upper = lower + zone[size];
    if (Math.abs(delta) <= EPSILON) {
      if (a[axis] < lower - EPSILON || a[axis] > upper + EPSILON) return false;
      continue;
    }
    let first = (lower - a[axis]) / delta, last = (upper - a[axis]) / delta;
    if (first > last) [first, last] = [last, first];
    entering = Math.max(entering, first);
    leaving = Math.min(leaving, last);
    if (entering > leaving + EPSILON) return false;
  }
  return true;
}

/** Speeds and widthKm are editable estimates, not Cyberpunk RED rules or surveyed road data. */
export function routeMetrics(points, options = {}) {
  const route = normalizeRoute(points, MAX_PATH_POINTS);
  const { aspect } = calibration(options);
  const widthKm = finite(options.widthKm === undefined ? 20 : options.widthKm, 'Ширина карты в км', { positive: true });
  const overrides = record(options.speeds === undefined ? {} : options.speeds, 'Скорости');
  for (const [mode, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_SPEEDS, mode)) throw new TypeError(`Неизвестный способ передвижения: ${mode}.`);
    finite(value, `Скорость ${mode}`, { positive: true });
  }
  const mode = options.mode === undefined ? 'walk' : options.mode;
  if (typeof mode !== 'string' || !Object.hasOwn(DEFAULT_SPEEDS, mode)) throw new TypeError('Неизвестный способ передвижения.');
  const speeds = { ...DEFAULT_SPEEDS, ...overrides };
  const zones = normalizeZones(options.zones === undefined ? [] : options.zones);
  let distanceKm = 0;
  const encountered = new Set();
  for (let i = 1; i < route.length; i++) {
    distanceKm += distance(route[i - 1], route[i], aspect) * widthKm;
    for (const zone of zones) {
      if (zone.threat !== 'safe' && !encountered.has(zone.id) && intersects(route[i - 1], route[i], zone)) encountered.add(zone.id);
    }
  }
  const minutes = distanceKm / speeds[mode] * 60;
  finite(distanceKm, 'Длина маршрута');
  finite(minutes, 'Время маршрута');
  const warnings = zones.filter(zone => encountered.has(zone.id)).map(zone =>
    `Маршрут пересекает зону «${zone.name}». Отметка угрозы ведущего: ${THREATS[zone.threat]}.`);
  return { distanceKm, minutes, warnings, estimated: true };
}

function graphFrom(roads, aspect) {
  if (!Array.isArray(roads) || roads.length > MAX_ROADS) throw new RangeError(`Допускается массив не более ${MAX_ROADS} дорожных отрезков.`);
  const nodes = new Map(), ids = new Set();
  function node(p) {
    const key = keyOf(p);
    if (!nodes.has(key)) nodes.set(key, { key, point: p, adjacent: new Map() });
    return nodes.get(key);
  }
  for (let i = 0; i < roads.length; i++) {
    const road = record(roads[i], `Дорога ${i + 1}`);
    if (typeof road.id !== 'string' || !road.id.trim() || road.id.length > 128 || ids.has(road.id)) {
      throw new TypeError(`Дорога ${i + 1}: нужен уникальный непустой id длиной не больше 128 символов.`);
    }
    ids.add(road.id);
    const a = point(road.a, `Дорога ${i + 1}, начало`), b = point(road.b, `Дорога ${i + 1}, конец`);
    if (samePoint(a, b)) throw new RangeError(`Дорога ${i + 1}: начало и конец совпадают.`);
    const from = node(a), to = node(b), weight = finite(distance(a, b, aspect), 'Длина дорожного отрезка', { positive: true });
    from.adjacent.set(to.key, weight);
    to.adjacent.set(from.key, weight);
  }
  return nodes;
}

function nearest(p, nodes, aspect) {
  let result = null, best = Infinity;
  for (const node of nodes.values()) {
    const next = distance(p, node.point, aspect);
    if (next < best || (next === best && (!result || node.point.x < result.point.x || (node.point.x === result.point.x && node.point.y < result.point.y)))) {
      result = node; best = next;
    }
  }
  return result;
}

/**
 * Undirected GM-authored roads. Only exact shared endpoints create junctions.
 * connectorSegments indexes explicit off-road start/end connectors: points[i] -> points[i+1].
 * Geometry crossings never create junctions, and disconnected components never fall back to a straight line.
 */
export function shortestRoadRoute(start, end, roads, options = {}) {
  const origin = point(start, 'Начало маршрута'), destination = point(end, 'Конец маршрута');
  const { aspect } = calibration(options);
  const nodes = graphFrom(roads, aspect);
  const unavailable = reason => ({ points: [], reason, connectorSegments: [] });
  if (!nodes.size) return unavailable('Дорожная сеть пуста. Добавьте связанные отрезки дорог.');
  if (samePoint(origin, destination)) return { points: [origin], reason: null, connectorSegments: [] };
  const first = nearest(origin, nodes, aspect), last = nearest(destination, nodes, aspect);
  const costs = new Map([[first.key, 0]]), previous = new Map(), visited = new Set();
  // At most 2000 endpoints. This bounded Dijkstra keeps the implementation dependency-free.
  while (visited.size < nodes.size) {
    let current = null, best = Infinity;
    for (const [key, value] of costs) if (!visited.has(key) && value < best) { current = key; best = value; }
    if (current === null) return unavailable('Между ближайшими дорожными узлами нет связанного маршрута. Проверьте соединения дорог.');
    if (current === last.key) break;
    visited.add(current);
    for (const [key, weight] of nodes.get(current).adjacent) {
      if (visited.has(key)) continue;
      const cost = finite(best + weight, 'Суммарная длина дорожного пути');
      if (cost < (costs.get(key) ?? Infinity)) { costs.set(key, cost); previous.set(key, current); }
    }
  }
  const path = [];
  for (let key = last.key; key !== undefined; key = previous.get(key)) path.push(nodes.get(key).point);
  path.reverse();
  if (!samePoint(path[0], first.point)) return unavailable('Дорожный маршрут не найден.');
  const points = [origin], connectorSegments = [];
  function append(p, connector = false) {
    if (samePoint(points.at(-1), p)) return;
    if (connector) connectorSegments.push(points.length - 1);
    points.push({ ...p });
  }
  append(path[0], true);
  for (const p of path.slice(1)) append(p);
  append(destination, true);
  return { points, reason: null, connectorSegments };
}
