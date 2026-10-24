import { normalizeRoute, routeMetrics } from './routes.js';

export const CITY_SCHEMA = 1;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const modes = ['walk', 'bike', 'car', 'av'];
const threats = ['safe', 'moderate', 'combat', 'hot'];
const clone = value => structuredClone(value);
export function emptyCity() {
  return { schemaVersion: CITY_SCHEMA, revision: 0, places: {}, overrides: {}, crew: null,
    sharedRoute: null, roads: [], zones: [], encounters: [],
    config: { widthKm: 20, speeds: { walk: 5, bike: 18, car: 35, av: 100 } } };
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error(`${label}: требуется объект.`);
  return value;
}
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`${label}: неизвестное поле ${key}.`);
}
export function cityId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
      || ['constructor', 'prototype', '__proto__'].includes(value)) throw Error('Некорректный идентификатор.');
  return value;
}
function string(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw Error(`${label}: некорректный текст (до ${max} знаков).`);
  return value.trim();
}
function bool(value) { if (typeof value !== 'boolean') throw Error('Ожидается логическое значение.'); return value; }
function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw Error(`${label}: число от ${min} до ${max}.`);
  return value;
}
export function cityPoint(value) { return normalizeRoute([value])[0]; }
export function safeImage(value) {
  const image = string(value, 1024, 'Путь изображения');
  if (!image) return '';
  if (/^https:\/\//i.test(image)) {
    const url = new URL(image);
    if (url.username || url.password) throw Error('Изображение: запрещены учётные данные в URL.');
    return image;
  }
  if (/^[A-Za-z0-9_]/.test(image) && !/[:\\<>\x00-\x1f]/.test(image)
      && !image.split('/').some(p => p === '..' || p === '.')) return image;
  throw Error('Изображение: нужен локальный путь Foundry или HTTPS URL.');
}
function market(value) {
  if (value === null) return null;
  keys(value, ['part', 'id'], 'Торговая точка');
  if (!['bodega', 'diner', 'vendit'].includes(value.part)) throw Error('Неизвестный тип торговой точки.');
  return { part: value.part, id: cityId(value.id) };
}
/** A Foundry Scene id for the place's battle map; '' clears the link. The scene itself is never copied into city data. */
function sceneId(value) {
  if (value === '' || value === null) return '';
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(value)) throw Error('Сцена места: некорректный идентификатор.');
  return value;
}
function place(value, partial = false) {
  keys(value, ['id', 'name', 'description', 'district', 'category', 'image', 'x', 'y', 'protected', 'market', 'scene', ...(partial ? ['hidden'] : [])], 'Место');
  const result = { id: cityId(value.id) };
  for (const [key, max] of Object.entries({ name: 160, description: 12000, district: 160, category: 80 })) {
    if (value[key] !== undefined) result[key] = string(value[key], max, key, key === 'name');
  }
  if (!partial && !result.name) throw Error('Нужно название места.');
  if (value.image !== undefined) result.image = safeImage(value.image);
  if (value.x !== undefined || value.y !== undefined) Object.assign(result, cityPoint(value));
  if (!partial && result.x === undefined) throw Error('Нужна точка места на карте.');
  if (value.protected !== undefined) result.protected = bool(value.protected);
  if (value.hidden !== undefined) result.hidden = bool(value.hidden);
  if (value.market !== undefined) result.market = market(value.market);
  if (value.scene !== undefined) result.scene = sceneId(value.scene);
  return result;
}
function list(value, max, label, validate) {
  if (!Array.isArray(value) || value.length > max) throw Error(`${label}: максимум ${max} записей.`);
  const ids = new Set();
  return Array.from(value, entry => {
    const result = validate(entry);
    if (ids.has(result.id)) throw Error(`${label}: повторный id ${result.id}.`);
    ids.add(result.id);
    return result;
  });
}
function roads(value) {
  return list(value, 1000, 'Дороги', entry => {
    keys(entry, ['id', 'a', 'b'], 'Участок дороги');
    const a = cityPoint(entry.a), b = cityPoint(entry.b);
    if (a.x === b.x && a.y === b.y) throw Error('Дороге нужны два разных конца.');
    return { id: cityId(entry.id), a, b };
  });
}
function zones(value) {
  const result = list(value, 256, 'Зоны', entry => {
    keys(entry, ['id', 'name', 'x', 'y', 'width', 'height', 'threat'], 'Зона');
    if (!threats.includes(entry.threat)) throw Error('Неизвестная угроза.');
    return { id: cityId(entry.id), name: string(entry.name, 160, 'Зона', true), ...cityPoint(entry),
      width: number(entry.width, Number.EPSILON, 1, 'Ширина'), height: number(entry.height, Number.EPSILON, 1, 'Высота'), threat: entry.threat };
  });
  routeMetrics([], { zones: result });
  return result;
}
function config(value) {
  keys(value, ['widthKm', 'speeds'], 'Масштаб');
  keys(value.speeds, modes, 'Скорости');
  return { widthKm: number(value.widthKm, 0.01, 10000, 'Ширина в км'),
    speeds: Object.fromEntries(modes.map(mode => [mode, number(value.speeds[mode], 0.01, 5000, 'Скорость')])) };
}
function encounters(value) {
  return list(value, 500, 'События', entry => {
    keys(entry, ['id', 'title', 'text', 'threat', 'time'], 'Событие');
    if (![...threats, 'any'].includes(entry.threat) || !['any', 'day', 'night'].includes(entry.time)) throw Error('Некорректный фильтр события.');
    return { id: cityId(entry.id), title: string(entry.title, 160, 'Событие', true), text: string(entry.text, 4000, 'Описание'), threat: entry.threat, time: entry.time };
  });
}
function sharedRoute(value) {
  if (value === null) return null;
  keys(value, ['points', 'mode'], 'Маршрут');
  if (!modes.includes(value.mode)) throw Error('Неизвестный транспорт.');
  return { points: normalizeRoute(value.points, 1003), mode: value.mode };
}
/** Public campaign overlay only. Unknown fields (including secrets) are rejected. */
export function validateCity(value, baseIds) {
  keys(value, Object.keys(emptyCity()), 'Город');
  if (value.schemaVersion !== CITY_SCHEMA) throw Error('Неподдерживаемая версия данных города.');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('Некорректная ревизия.');
  const output = emptyCity();
  output.revision = value.revision;
  for (const field of ['places', 'overrides']) {
    object(value[field], field);
    if (Object.keys(value[field]).length > 1000) throw Error('Слишком много мест.');
    for (const [id, record] of Object.entries(value[field])) {
      cityId(id);
      if (record?.id !== id) throw Error('Идентификаторы места не совпадают.');
      if (field === 'places' && (!id.startsWith('custom-') || baseIds?.has(id))) throw Error('Пользовательскому месту нужен id custom-…');
      if (field === 'overrides' && baseIds && !baseIds.has(id)) throw Error(`Исходное место ${id} отсутствует в атласе.`);
      output[field][id] = place(record, field === 'overrides');
    }
  }
  output.crew = value.crew === null ? null : cityPoint(value.crew);
  output.sharedRoute = sharedRoute(value.sharedRoute);
  output.roads = roads(value.roads);
  output.zones = zones(value.zones);
  output.config = config(value.config);
  output.encounters = encounters(value.encounters);
  return output;
}
/** Called only by the active GM; an expected revision protects stale import/edit dialogs. */
export function applyCityOperation(current, op, payload, context = {}) {
  if (!context.isGM) throw Error('Изменять общие данные города может только Мастер.');
  const state = validateCity(current, context.baseIds);
  if (context.expectedRevision !== undefined && context.expectedRevision !== state.revision) throw Error('Данные уже изменились. Обновите окно и повторите.');
  object(payload, 'Команда');
  switch (op) {
    case 'place.save': {
      const record = place({ ...payload, id: payload.id || context.newId });
      state.places[record.id] = record;
      break;
    }
    case 'place.remove': {
      const id = cityId(payload.id);
      if (state.places[id]?.protected) throw Error('Сначала снимите защиту места от удаления.');
      delete state.places[id]; break;
    }
    case 'override.save': {
      const id = cityId(payload.id);
      state.overrides[id] = place({ ...state.overrides[id], ...payload }, true); break;
    }
    case 'override.reset': delete state.overrides[cityId(payload.id)]; break;
    case 'crew.set': state.crew = payload.point === null ? null : cityPoint(payload.point); break;
    case 'route.publish': state.sharedRoute = sharedRoute(payload); break;
    case 'roads.set': state.roads = roads(payload.roads); break;
    case 'zones.set': state.zones = zones(payload.zones); break;
    case 'config.set': state.config = config(payload.config); break;
    case 'encounters.set': state.encounters = encounters(payload.encounters); break;
    case 'import': {
      const imported = validateCity(payload.state, context.baseIds);
      // Protected custom places may not be removed or overwritten by a bulk import.
      for (const [id, record] of Object.entries(state.places)) if (record.protected
        && JSON.stringify(record) !== JSON.stringify(imported.places[id])) throw Error(`Импорт затрагивает защищённое место: ${record.name}.`);
      imported.revision = state.revision + 1;
      return imported;
    }
    default: throw Error('Неизвестная команда города.');
  }
  state.revision++;
  return validateCity(state, context.baseIds);
}
export function projectCity(dataset, state) {
  const locations = dataset.locations.filter(p => !state.overrides[p.id]?.hidden).map(original => {
    const patch = state.overrides[original.id];
    if (!patch) return original;
    const output = { ...original, ...patch, campaignEdited: true };
    if (patch.x !== undefined) {
      // Keep source codes searchable while clearly identifying a GM-authored position.
      const markers = original.mapMarkers?.length ? original.mapMarkers : [{ code: '●' }];
      output.mapMarkers = markers.map(marker => ({ ...marker, x: patch.x, y: patch.y, kind: 'campaign' }));
    }
    return output;
  });
  for (const p of Object.values(state.places)) locations.push({ ...p, aliases: [], sourceUrl: '', originalMapReferences: [],
    campaignEdited: true, mapMarkers: [{ x: p.x, y: p.y, code: '●', kind: 'campaign' }] });
  return { ...dataset, locations };
}
export function exportCity(state, baseIds) {
  return JSON.stringify({ format: 'night-city-atlas-campaign', version: 1, city: validateCity(state, baseIds) }, null, 2);
}
export function importCity(json, baseIds) {
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > MAX_IMPORT_BYTES) throw Error('Файл импорта должен быть не больше 2 МБ.');
  const data = JSON.parse(json);
  keys(data, ['format', 'version', 'city'], 'Файл импорта');
  if (data.format !== 'night-city-atlas-campaign' || data.version !== 1) throw Error('Это не экспорт кампании нашего атласа.');
  return validateCity(data.city, baseIds);
}
