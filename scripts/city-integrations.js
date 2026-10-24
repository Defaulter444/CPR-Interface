import { cityId, cityPoint, exportCity, importCity } from './city-model.js';
import { normalizeRoute, routeMetrics } from './routes.js';
import { THREAT_LABELS } from './street-life.js';
import { MOOK_PACK, MOOKS } from './mook-pack.js';

const MODULE_ID = 'night-city-2045-atlas';
// Survives Application rerenders: adapters are recreated, the store is not.
const travelingStores = new WeakSet();
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function canOpenAtlas() { return Boolean(game.user?.isGM || game.settings.get(MODULE_ID, 'playerAccess')); }
export function assertCityGM() {
  if (!game.user?.isGM) throw Error('Общие данные города изменяет только Мастер.');
  const active = game.users?.activeGM;
  if (active && active.id !== game.user.id) throw Error(`Редактирование доступно активному Мастеру: ${active.name}. Это защищает город от одновременных записей.`);
}
export function cityClock() {
  try {
    const value = game.modules.get('night-city-agent')?.api?.clock?.();
    if (value?.label && ['calendar', 'world'].includes(value.source)) return value.label;
    const api = globalThis.SimpleCalendar?.api;
    if (api?.timestampToDate && api?.currentDateTime) {
      const date = api.currentDateTime();
      return `${date.year} · ${Number(date.month) + 1}/${Number(date.day) + 1} ${String(date.hour).padStart(2, '0')}:${String(date.minute).padStart(2, '0')}`;
    }
  } catch (_) { /* World time remains available when an optional clock is absent. */ }
  const total = Math.floor(game.time?.worldTime ?? 0);
  return `Время мира: ${Math.floor(total / 3600)} ч ${Math.floor(total % 3600 / 60)} мин`;
}
/** Hour of the in-game day for night mode and encounter tables: Agent clock, then Simple Calendar, then world time. */
export function cityHour() {
  try {
    const value = game.modules.get('night-city-agent')?.api?.clock?.();
    const match = ['calendar', 'world'].includes(value?.source) ? /^(\d{1,2}):/.exec(value.timeLabel ?? '') : null;
    if (match) return Number(match[1]) % 24;
    const api = globalThis.SimpleCalendar?.api;
    if (game.modules.get('foundryvtt-simple-calendar')?.active && api?.currentDateTime) {
      const hour = Number(api.currentDateTime()?.hour);
      if (Number.isFinite(hour)) return hour % 24;
    }
  } catch (_) { /* Fall back to world time below. */ }
  return Math.floor(Math.floor(game.time?.worldTime ?? 0) / 3600) % 24;
}
/** Players who would walk into a street encounter: owners of a character, at least one. */
export function crewSize() {
  const players = Array.from(game.users ?? []).filter(user => !user.isGM);
  return Math.max(1, players.filter(user => user.character).length || players.length);
}
const NPC_PACK = `${MODULE_ID}.npc`;
const ENCOUNTER_FOLDER = 'Атлас · уличные встречи';
async function encounterFolder() {
  return game.folders.find(f => f.type === 'Actor' && f.name === ENCOUNTER_FOLDER && f.getFlag?.(MODULE_ID, 'encounters'))
    ?? await Folder.create({ name: ENCOUNTER_FOLDER, type: 'Actor', color: '#c8323c', flags: { [MODULE_ID]: { encounters: true } } });
}
/** One world copy per compendium actor, reused on later encounters so the GM can tune it once. */
async function worldActor(pack, id) {
  const uuid = `Compendium.${pack.collection}.Actor.${id}`;
  const existing = game.actors.find(actor => actor.getFlag?.(MODULE_ID, 'source') === uuid);
  if (existing) return existing;
  const folder = await encounterFolder();
  const actor = await game.actors.importFromCompendium(pack, id, { folder: folder.id }, { keepId: false });
  await actor?.setFlag(MODULE_ID, 'source', uuid);
  return actor;
}
/** Resolve who stands on the scene: the Mook Pack when installed, otherwise the bundled «Найт-Сити · персонажи». */
async function encounterCast(result, crew) {
  const mookPack = game.packs.get(MOOK_PACK);
  if (mookPack && result.mooks?.length) {
    return result.mooks.flatMap((group, index) => {
      const entry = MOOKS[group]?.[0];
      return entry ? [{ pack: mookPack, id: entry.id, count: index === 0 ? crew : 1 }] : [];
    });
  }
  const pack = game.packs.get(NPC_PACK);
  if (!pack) throw Error('Компендиум «Найт-Сити · персонажи» не найден. Переустановите атлас.');
  const index = await pack.getIndex();
  return (result.cast ?? []).flatMap(({ name, count }) => {
    const entry = index.find(e => e.name === name);
    return entry ? [{ pack, id: entry._id, count }] : [];
  });
}
/** Exactly one clock advances. An optional calendar failure must not advance the fallback too. */
export async function advanceTravelClock(seconds, { calendar, world } = {}) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 31536000) throw Error('Некорректная длительность путешествия.');
  if (calendar?.changeDate) {
    const result = await calendar.changeDate({ seconds });
    if (result === false) throw Error('Календарь отклонил изменение времени.');
  } else await world.advance(seconds);
}
export function createCityAdapters({ store, dataset, refresh }) {
  const baseIds = new Set(dataset.locations.map(p => p.id));
  const execute = async (op, payload, revision) => {
    const result = await store.execute(op, payload, revision);
    refresh();
    return result;
  };
  return {
    isGM: () => Boolean(game.user?.isGM),
    getState: () => store.read(), execute,
    getPositions: () => Array.from(game.users ?? []).flatMap(user => {
      try { const point = user.getFlag(MODULE_ID, 'position'); return point ? [{ id: user.id, name: user.name, ...cityPoint(point) }] : []; }
      catch (_) { return []; }
    }),
    setPersonalPosition: async point => {
      if (!canOpenAtlas()) throw Error('Доступ к атласу выключен.');
      if (point === null) await game.user.unsetFlag(MODULE_ID, 'position');
      else await game.user.setFlag(MODULE_ID, 'position', cityPoint(point));
      refresh();
    },
    clock: cityClock,
    travel: async (points, mode) => {
      assertCityGM();
      if (travelingStores.has(store)) throw Error('Путешествие уже выполняется.');
      travelingStores.add(store);
      try {
        const path = normalizeRoute(points, 1003);
        if (path.length < 2) throw Error('Сначала составьте маршрут.');
        const state = store.read();
        const result = routeMetrics(path, { ...state.config, mapWidth: dataset.map.width, mapHeight: dataset.map.height, zones: state.zones, mode });
        const seconds = Math.ceil(result.minutes * 60);
        if (seconds <= 0 || seconds > 31536000) throw Error('Длительность вне допустимого диапазона.');
        const accepted = await Dialog.confirm({ title: 'Переместить группу?', content: `<p>Примерно ${result.distanceKm.toFixed(2)} км, ${Math.ceil(result.minutes)} мин. Продвинуть игровые часы и перенести общую метку группы?</p><p>Масштаб и скорости — настройки Мастера, оценка не учитывает пробки.</p>` });
        if (!accepted) return;
        await store.flush();
        assertCityGM();
        if (store.read().revision !== state.revision) throw Error('Город изменился. Проверьте маршрут ещё раз.');
        const calendarActive = game.modules.get('foundryvtt-simple-calendar')?.active;
        const calendar = calendarActive ? globalThis.SimpleCalendar?.api : null;
        if (calendarActive && !calendar?.changeDate) throw Error('Simple Calendar ещё не готов. Время не изменено.');
        await advanceTravelClock(seconds, { calendar, world: game.time });
        try { await execute('crew.set', { point: path.at(-1) }, state.revision); }
        catch (error) { throw Error(`Часы уже продвинуты; метка группы не сохранена. Переставьте её вручную, не повторяйте путешествие. ${error.message}`); }
        ui.notifications.info(`Группа прибыла. Время продвинуто на ${Math.ceil(result.minutes)} мин.`);
      } finally { travelingStores.delete(store); }
    },
    openAgent: async tab => {
      const api = game.modules.get('night-city-agent')?.api;
      if (typeof api?.openAgent !== 'function') throw Error('Модуль «Найт-Сити Агент» не активен.');
      await api.openAgent({ tab: ['map', 'jobs'].includes(tab) ? tab : 'map' });
    },
    jobsForLocation: async id => await game.modules.get('night-city-agent')?.api?.jobsForLocation?.(cityId(id)) ?? [],
    openJob: async id => await game.modules.get('night-city-agent')?.api?.openJob?.(id),
    draftJobForLocation: async location => {
      const api = game.modules.get('night-city-agent')?.api;
      if (!api?.draftJobForLocation) throw Error('Для создания связанного заказа нужен «Агент» версии 0.17.3.');
      await api.draftJobForLocation({ id: location.id, name: location.name });
    },
    openMarket: async link => {
      if (!game.nightCityMarket?.openShop) throw Error('Модуль «Торговля Найт-Сити» не активен.');
      await game.nightCityMarket.openShop(link.part, cityId(link.id));
    },
    listShops: () => {
      if (!game.user?.isGM || !game.nightCityMarket?.openShop) return [];
      return [['bodega', 'bodegaDb', 'shops'], ['diner', 'dinerDb', 'diners'], ['vendit', 'venditDb', 'vendits']].flatMap(([part, setting, field]) => {
        try { return Object.values(game.settings.get('night-city-market', setting)?.[field] ?? {}).map(p => ({ part, id: p.id, name: p.name })); }
        catch (_) { return []; }
      });
    },
    clockHour: cityHour,
    nightMode: () => { try { return game.settings.get(MODULE_ID, 'nightMode') !== false; } catch (_) { return true; } },
    crewSize,
    listScenes: () => game.user?.isGM ? Array.from(game.scenes ?? []).map(scene => ({ id: scene.id, name: scene.name })) : [],
    openScene: async (location, { activate = false } = {}) => {
      assertCityGM();
      const scene = game.scenes.get(location?.scene);
      if (!scene) throw Error('Сцена места не найдена. Выберите её заново в редакторе места.');
      if (!activate) return scene.view();
      const accepted = await Dialog.confirm({ title: 'Перенести игроков?', content: `<p>Активировать сцену «${escapeHTML(scene.name)}» для всех участников?</p>` });
      if (accepted) await scene.activate();
    },
    postEncounter: async (result, { reveal = false } = {}) => {
      assertCityGM();
      if (!result) throw Error('Сначала бросьте встречу.');
      const meta = [THREAT_LABELS[result.threat], result.night ? 'ночь' : 'день', result.district, result.gang && result.gang !== 'местная банда' ? `банда: ${result.gang}` : ''].filter(Boolean).join(' · ');
      const secret = reveal ? '' : `${result.stats && result.stats !== '—' ? `<p><b>Статы:</b> ${escapeHTML(result.stats)}</p>` : ''}${result.twist ? `<p><b>Поворот:</b> ${escapeHTML(result.twist)}</p>` : ''}`;
      const content = `<article class="nc-atlas-encounter"><p class="nc-atlas-encounter__meta">${escapeHTML(meta)}</p><h3>${escapeHTML(result.title)}</h3><p style="white-space:pre-wrap">${escapeHTML(result.text)}</p>${secret}</article>`;
      await ChatMessage.create({ content, speaker: { alias: 'Улицы Найт-Сити' }, whisper: reveal ? [] : ChatMessage.getWhisperRecipients('GM').map(user => user.id) });
      ui.notifications.info(reveal ? 'Встреча показана участникам.' : 'Встреча отправлена Мастеру в чат.');
    },
    spawnEncounter: async result => {
      assertCityGM();
      if (!canvas?.scene) throw Error('Нет активной сцены: откройте сцену, куда выставить участников встречи.');
      const cast = await encounterCast(result ?? {}, crewSize());
      if (!cast.length) throw Error('Для этой встречи нет готовых персонажей. Выставьте их вручную.');
      const grid = canvas.grid.size, center = canvas.stage.pivot, documents = [], names = [];
      for (const { pack, id, count } of cast) {
        const actor = await worldActor(pack, id);
        if (!actor) continue;
        const base = (await actor.getTokenDocument()).toObject();
        names.push(`${actor.name} ×${count}`);
        for (let i = 0; i < count; i++) {
          const n = documents.length;
          documents.push({ ...base, hidden: true, x: Math.round((center.x + (n % 4) * grid - grid * 1.5) / grid) * grid, y: Math.round((center.y + Math.floor(n / 4) * grid - grid) / grid) * grid });
        }
      }
      if (!documents.length) throw Error('Персонажи встречи не найдены в компендиуме.');
      await canvas.scene.createEmbeddedDocuments('Token', documents);
      ui.notifications.info(`На сцену: ${names.join(', ')}. Токены скрыты — откройте их, когда группа заметит встречу.`);
    },
    draftGigForLocation: async (location, gig) => {
      const module = game.modules.get('night-city-agent'), api = module?.api;
      if (!api?.draftJobForLocation) throw Error('Для заказов нужен активный «Агент».');
      if (foundry.utils.isNewerVersion('0.18.0', module.version ?? '0')) ui.notifications.warn('«Агент» старше 0.18: откроется пустой черновик, поля заказа не заполнятся.');
      await api.draftJobForLocation({ id: location.id, name: location.name }, gig);
    },
    showDossier: async location => {
      assertCityGM();
      const content = `<article class="nc-atlas-dossier"><h3>${escapeHTML(location.name)}</h3><p>${escapeHTML(location.district)}</p><p style="white-space:pre-wrap">${escapeHTML(location.description)}</p></article>`;
      await ChatMessage.create({ content, speaker: { alias: 'Атлас Найт-Сити' } });
      ui.notifications.info('Карточка места отправлена в общий чат.');
    },
    exportData: () => saveDataToFile(exportCity(store.read(), baseIds), 'application/json', 'night-city-campaign.json'),
    importData: async json => {
      assertCityGM();
      const state = importCity(json, baseIds), current = store.read();
      const accepted = await Dialog.confirm({ title: 'Заменить общие данные города?', content: `<p>В файле: ${Object.keys(state.places).length} мест, ${state.roads.length} дорог, ${state.zones.length} зон, ${state.encounters.length} событий.</p><p>Общие метки, правки мест и маршруты будут заменены. Исходный справочник остаётся. Перед записью сохранится резервная копия.</p>` });
      if (!accepted) return current;
      assertCityGM();
      // Persist a local backup before mutation; failure leaves the current city untouched.
      const backup = exportCity(current, baseIds);
      await game.settings.set(MODULE_ID, 'importBackup', backup);
      saveDataToFile(backup, 'application/json', 'night-city-before-import.json');
      return execute('import', { state }, current.revision);
    },
    pickImage: () => new Promise((resolve, reject) => {
      class AtlasImagePicker extends FilePicker {
        async close(options) { try { return await super.close(options); } finally { resolve(''); } }
      }
      const picker = new AtlasImagePicker({ type: 'image', callback: path => resolve(path) });
      Promise.resolve(picker.browse()).catch(reject);
    })
  };
}
