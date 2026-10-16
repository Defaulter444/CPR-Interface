import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCity } from '../scripts/city-model.js';
import { createCityStore } from '../scripts/city-store.js';
import { assertCityGM, createCityAdapters } from '../scripts/city-integrations.js';

const path = [{ x: 0, y: 0 }, { x: .25, y: 0 }];
const destination = path.at(-1);
function fixture(t, { calendarActive = false, calendar } = {}) {
  const globals = new Map(['game', 'Dialog', 'ui', 'SimpleCalendar'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const log = [], confirmations = [];
  let state = emptyCity();
  const user = { id: 'gm', name: 'GM', isGM: true,
    setFlag: async (module, key, value) => log.push({ action: 'setFlag', user: user.id, module, key, value }),
    unsetFlag: async (module, key) => log.push({ action: 'unsetFlag', user: user.id, module, key }) };
  const other = { id: 'other', name: 'Other', isGM: false, setFlag() { throw Error('A personal position must not write another user'); } };
  const users = [user, other];users.activeGM = user;
  const modules = new Map([['foundryvtt-simple-calendar', { active: calendarActive }]]);
  globalThis.game = { user, users, modules, settings: { get: () => true },
    time: { advance: async seconds => { log.push({ action: 'world', seconds }); } } };
  globalThis.SimpleCalendar = calendar ? { api: calendar } : {};
  globalThis.Dialog = { confirm: () => new Promise(resolve => confirmations.push(resolve)) };
  globalThis.ui = { notifications: { info: text => log.push({ action: 'notice', text }) } };
  const store = createCityStore({ read: () => state, write: async next => { state = next; log.push({ action: 'write', revision: next.revision }); },
    baseIds: new Set(), authorize: assertCityGM, newId: () => 'custom-test' });
  const adapters = () => createCityAdapters({ store, dataset: { locations: [], map: { width: 1200, height: 1855 } }, refresh() {} });
  return { log, confirmations, store, user, users, modules, adapters, state: () => state,
    confirm(value = true) { const resolve = confirmations.shift();assert.ok(resolve, 'a native confirmation is pending');resolve(value); } };
}

test('two render adapters sharing a store cannot advance one journey twice', async t => {
  const f = fixture(t), oldRender = f.adapters(), newRender = f.adapters();
  const first = oldRender.travel(path, 'walk');
  const second = newRender.travel(path, 'walk');
  const all = Promise.allSettled([first, second]);
  const dialogs = f.confirmations.length;
  while (f.confirmations.length) f.confirm();
  const outcomes = await all;
  assert.equal(dialogs, 1, 're-render must retain the same travel lock');
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.match(outcomes[1].reason.message, /уже выполняется/);
  assert.deepEqual(f.log.filter(entry => entry.action === 'world'), [{ action: 'world', seconds: 3600 }]);
  assert.equal(f.state().revision, 1);
  assert.deepEqual(f.state().crew, destination);
});

test('cancelled travel changes neither clock nor crew and releases the shared lock', async t => {
  const f = fixture(t);
  const cancelled = f.adapters().travel(path, 'walk');
  f.confirm(false);await cancelled;
  assert.equal(f.log.length, 0);assert.equal(f.state().revision, 0);
  const retry = f.adapters().travel(path, 'walk');
  f.confirm();await retry;
  assert.equal(f.log.filter(entry => entry.action === 'world').length, 1);
  assert.deepEqual(f.state().crew, destination);
});

test('authority is checked again after the confirmation, before either world write', async t => {
  for (const change of ['role-revoked', 'primary-gm-changed']) await t.test(change, async t => {
    const f = fixture(t), pending = f.adapters().travel(path, 'walk');
    if (change === 'role-revoked') f.user.isGM = false;
    else f.users.activeGM = { id: 'another-gm', name: 'Another GM', isGM: true };
    f.confirm();
    await assert.rejects(pending, /Мастер/);
    assert.deepEqual(f.log, []);assert.equal(f.state().revision, 0);assert.equal(f.state().crew, null);
  });
});

test('a changed city revision invalidates an open travel confirmation without advancing time', async t => {
  const f = fixture(t), pending = f.adapters().travel(path, 'walk');
  await f.store.execute('crew.set', { point: { x: .8, y: .8 } });
  f.confirm();await assert.rejects(pending, /Город изменился/);
  assert.equal(f.log.filter(entry => entry.action === 'world').length, 0);
  assert.deepEqual(f.state().crew, { x: .8, y: .8 });
  assert.equal(f.state().revision, 1);
});

test('an active but unready Simple Calendar never advances the world fallback or the crew', async t => {
  const f = fixture(t, { calendarActive: true }), adapter = f.adapters();
  const pending = adapter.travel(path, 'walk');f.confirm();
  await assert.rejects(pending, /Simple Calendar ещё не готов/);
  assert.deepEqual(f.log, []);assert.equal(f.state().revision, 0);
  globalThis.SimpleCalendar.api = { changeDate: async ({ seconds }) => { f.log.push({ action: 'calendar', seconds });return true; } };
  const retry = f.adapters().travel(path, 'walk');f.confirm();await retry;
  assert.deepEqual(f.log.filter(entry => ['calendar', 'world'].includes(entry.action)), [{ action: 'calendar', seconds: 3600 }]);
  assert.equal(f.state().revision, 1);
});

test('a calendar rejection preserves crew and releases the lock without a fallback clock change', async t => {
  const f = fixture(t, { calendarActive: true, calendar: { changeDate: async () => false } });
  const pending = f.adapters().travel(path, 'walk');f.confirm();
  await assert.rejects(pending, /Календарь отклонил/);
  assert.deepEqual(f.log, []);assert.equal(f.state().revision, 0);
  f.modules.get('foundryvtt-simple-calendar').active = false;
  const retry = f.adapters().travel(path, 'walk');f.confirm();await retry;
  assert.equal(f.log.filter(entry => entry.action === 'world').length, 1);
});

test('personal position writes target only the current user and recheck atlas access', async t => {
  const f = fixture(t);f.user.isGM = false;f.user.id = 'player';
  const adapter = f.adapters();
  await adapter.setPersonalPosition({ x: .4, y: .6, id: 'other' });
  await adapter.setPersonalPosition(null);
  assert.deepEqual(f.log, [
    { action: 'setFlag', user: 'player', module: 'night-city-2045-atlas', key: 'position', value: { x: .4, y: .6 } },
    { action: 'unsetFlag', user: 'player', module: 'night-city-2045-atlas', key: 'position' }
  ]);
  game.settings.get = () => false;
  await assert.rejects(adapter.setPersonalPosition({ x: .1, y: .1 }), /Доступ к атласу выключен/);
  assert.equal(f.log.length, 2);assert.equal(f.state().revision, 0);
});
