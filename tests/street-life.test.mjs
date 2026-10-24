import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DISTRICT_PROFILES, isNightHour, maxThreat, mookGroups, rollGig, rollStreetEncounter, threatAt } from '../scripts/street-life.js';
import { MOOKS, MOOK_GROUP_LABELS } from '../scripts/mook-pack.js';
import { applyCityOperation, emptyCity } from '../scripts/city-model.js';

const sequence = (...values) => { let i = 0; return () => values[i++ % values.length]; };
const NPCS = ['Корп-исполнитель', 'Медтех-фрилансер', 'Барон', 'Частный детектив', 'Вышибала «Посмертия»', 'Нетраннер-одиночка', 'Агент Арасаки',
  'Журналист Нетворк 54', 'Техник-реставратор', 'Главарь бустеров', 'Бармен-информатор', 'Падре', 'Мечник Тигриных Когтей', 'Органлеггер',
  'Уличный гонщик', 'Мама Вуду', 'Коп-взяточник', 'Наёмный убийца', 'Риппердок', 'Кейси «Сто процентов»', 'Тихоня Мэй', 'Бездомный ветеран',
  'Киберпсих «Хромированный Бык»', 'Наёмник-ветеран'];

test('every atlas district has a street profile', () => {
  const districts = new Set(JSON.parse(readFileSync('data/locations.json', 'utf8')).locations.map(l => l.district).filter(Boolean));
  for (const district of districts) assert.ok(DISTRICT_PROFILES[district], district);
});

test('core tables follow threat: corporate calm half, combat deadly half, hot zone own list', () => {
  for (let i = 0; i < 200; i++) {
    const random = Math.random;
    const safe = rollStreetEncounter({ threat: 'safe', random }), combat = rollStreetEncounter({ threat: 'combat', random });
    const hot = rollStreetEncounter({ threat: 'hot', random }), moderate = rollStreetEncounter({ threat: 'moderate', night: true, random });
    assert.ok(safe.roll >= 1 && safe.roll <= 6); assert.ok(combat.roll >= 5 && combat.roll <= 10);
    assert.ok(hot.roll >= 1 && hot.roll <= 6); assert.ok(moderate.roll >= 1 && moderate.roll <= 10);
    for (const e of [safe, combat, hot, moderate]) { assert.ok(e.title && e.text); assert.ok(!e.text.includes('{g}') && !e.twist.includes('{g}')); }
  }
  assert.equal(rollStreetEncounter({ threat: 'safe', random: () => 0.99 }).title, 'Частный детектив');
});

test('district gangs fill the text and crowds scale with players; cast names exist in the compendium', () => {
  const e = rollStreetEncounter({ threat: 'combat', night: true, district: 'Кабуки', players: 4, random: sequence(0, 0.99, 0.1) });
  assert.equal(e.gang, 'Тигриные Когти');
  assert.ok(e.text.includes('Тигриные Когти'));
  assert.deepEqual(e.cast.map(c => c.name), ['Главарь бустеров', 'Наёмник-ветеран', 'Мечник Тигриных Когтей']);
  for (let i = 0; i < 300; i++) for (const c of rollStreetEncounter({ threat: ['safe', 'moderate', 'combat', 'hot'][i % 4], night: i % 2 === 0, players: 3 }).cast) assert.ok(NPCS.includes(c.name), c.name);
  const crowd = rollStreetEncounter({ threat: 'safe', players: 5, random: sequence(0.2, 0.3, 0.1) });
  assert.equal(crowd.title, 'Корпоративная охрана'); assert.equal(crowd.cast[0].count, 5);
});

test('authored encounters mix in by share and respect threat/time; book tables can be switched off', () => {
  const authored = [{ id: 'a', title: 'Своя', text: 'Банда {g} у входа', threat: 'moderate', time: 'night' }];
  const own = rollStreetEncounter({ threat: 'moderate', night: true, district: 'Глен', authored, useBook: false });
  assert.equal(own.source, 'own'); assert.equal(own.text, 'Банда 6-я улица у входа');
  assert.equal(rollStreetEncounter({ threat: 'moderate', night: false, authored, useBook: false }), null);
  assert.equal(rollStreetEncounter({ threat: 'combat', night: true, authored, useBook: false }), null);
});

test('GM zones override district threat; the most dangerous zone wins', () => {
  const zones = [{ x: 0, y: 0, width: .5, height: .5, threat: 'combat' }, { x: .2, y: .2, width: .1, height: .1, threat: 'hot' }];
  assert.equal(threatAt({ x: .25, y: .25 }, { zones, district: 'Нью-Уэстбрук' }), 'hot');
  assert.equal(threatAt({ x: .4, y: .4 }, { zones, district: 'Нью-Уэстбрук' }), 'combat');
  assert.equal(threatAt({ x: .9, y: .9 }, { zones, district: 'Нью-Уэстбрук' }), 'safe');
  assert.equal(threatAt(null, { district: 'Неизвестный' }), 'moderate');
  assert.equal(maxThreat(['safe', 'combat', 'moderate']), 'combat');
  assert.ok(isNightHour(22) && isNightHour(3) && !isNightHour(12) && !isNightHour(null));
});

test('gig generator writes an Agent-ready draft for the chosen place', () => {
  const gig = rollGig({ name: 'Посмертие', district: 'Верхняя Гавань' }, { players: 3, random: sequence(0.1, 0.2, 0.3, 0.4, 0.5) });
  assert.match(gig.title, /: Посмертие$/);
  assert.ok(gig.body.includes('«Посмертие»') && gig.body.includes('Заказчик:') && gig.body.includes('осложнение'));
  assert.ok(Number.isSafeInteger(gig.reward) && gig.reward > 0 && gig.reward % 3 === 0);
  assert.equal(gig.steps.length, 4);
  assert.throws(() => rollGig({}), /место/);
});

test('Mook Pack groups resolve for every encounter and gang', () => {
  for (const group of mookGroups('Война банд', 'Мальстрём')) assert.ok(MOOKS[group]?.length, group);
  assert.deepEqual(mookGroups('Засада', 'Неизвестные'), ['gangsters']);
  for (const key of Object.keys(MOOKS)) assert.ok(MOOK_GROUP_LABELS[key], key);
});

test('a place can link a scene; bad ids are rejected and empty clears it', () => {
  const ctx = { isGM: true, baseIds: new Set(), newId: 'custom-bar' };
  const state = applyCityOperation(emptyCity(), 'place.save', { name: 'Бар', x: .1, y: .1, scene: 'AbCdEf0123456789' }, ctx);
  assert.equal(state.places['custom-bar'].scene, 'AbCdEf0123456789');
  assert.equal(applyCityOperation(state, 'place.save', { ...state.places['custom-bar'], scene: '' }, ctx).places['custom-bar'].scene, '');
  assert.throws(() => applyCityOperation(emptyCity(), 'place.save', { name: 'Бар', x: .1, y: .1, scene: '../x' }, ctx), /Сцена места/);
});
