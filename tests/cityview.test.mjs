import test from 'node:test';
import assert from 'node:assert/strict';
import { CityControls, chooseEncounter, zoneRectangle, changedPlaceFields, jobStatusLabel } from '../scripts/city-controls.js';
import { AtlasMapController } from '../scripts/map-controller.js';
import { applyCityOperation, emptyCity } from '../scripts/city-model.js';

const a={x:.1,y:.1}, b={x:.9,y:.9};
function controls(overrides={}){
  const c=Object.create(CityControls.prototype);
  Object.assign(c,{route:[a,b],followRoads:true,state:{roads:[]},map:{dataset:{map:{width:1000,height:1000}}},setMessage(message){this.message=message;},...overrides});return c;
}

test('road mode never replaces an unavailable graph with a usable direct route',()=>{
  const c=controls(),result=c.resolvedRoute();
  assert.equal(result.valid,false);assert.deepEqual(result.points,[]);assert.ok(result.warnings[0]);
  c.followRoads=false;assert.deepEqual(c.resolvedRoute().points,[a,b]);assert.equal(c.resolvedRoute().valid,true);
});
test('disconnected roads cannot be published or used for travel',()=>{
  const c=controls({state:{roads:[{id:'one',a,b:{x:.2,y:.2}},{id:'two',a:{x:.8,y:.8},b}]}});
  c.command=()=>assert.fail('must not publish disconnected path');c.run=()=>assert.fail('must not travel disconnected path');
  c.handleGMAction('publish');assert.match(c.message,/маршрут|соединен/i);
  c.handleGMAction('travel');assert.equal(c.resolvedRoute().valid,false);
});
test('connected road paths preserve explicit off-road connector warnings',()=>{
  const c=controls({state:{roads:[{id:'road',a:{x:.2,y:.2},b:{x:.8,y:.8}}]}}),result=c.resolvedRoute();
  assert.equal(result.valid,true);assert.equal(result.points.length,4);assert.match(result.warnings.join(' '),/прямым отрезком/);
});
test('copied graph paths exceeding manual waypoint limit cannot be re-routed accidentally',()=>{
  const c=controls({route:Array.from({length:65},(_,i)=>({x:i/65,y:.5}))});
  assert.equal(c.resolvedRoute().valid,false);c.followRoads=false;assert.equal(c.resolvedRoute().valid,true);
});
test('manual route accepts at most 64 points and does not write shared state',()=>{
  const c=controls({clickMode:'route',route:Array.from({length:64},()=>({...a})),render(){},renderOverlay(){}});
  assert.equal(c.onMapClick(b),true);assert.equal(c.route.length,64);assert.match(c.message,/64/);
});
test('zone corners normalize all drawing directions and reject degenerate/outside shapes',()=>{
  assert.deepEqual(zoneRectangle({x:.8,y:.7},{x:.2,y:.1}),{x:.2,y:.1,width:.6000000000000001,height:.6});
  assert.equal(zoneRectangle(a,{x:.1,y:.8}),null);assert.equal(zoneRectangle(a,{x:2,y:.8}),null);
});
test('authored encounter selection respects time, threat and any filters',()=>{
  const entries=[{title:'Day',time:'day',threat:'hot'},{title:'Night',time:'night',threat:'hot'},{title:'Any',time:'any',threat:'any'}];
  assert.equal(chooseEncounter(entries,{time:'night',threat:'hot',random:()=>0}).title,'Night');
  assert.equal(chooseEncounter(entries,{time:'day',threat:'moderate',random:()=>0}).title,'Any');
  assert.equal(chooseEncounter([]),null);assert.equal(chooseEncounter(entries,{random:()=>1}).title,'Any');
});
test('map extension receives normalized clicks without stealing drag or native placement',()=>{
  let calls=0,received;
  const c=Object.create(AtlasMapController.prototype);
  Object.assign(c,{drag:{id:1,moved:false},state:{placement:true},view:{x:10,y:20,scale:2},dataset:{map:{width:100,height:200}},nodes:{viewport:{getBoundingClientRect:()=>({left:5,top:7})}},adapters:{onMapClick:p=>{calls++;received=p;return true;}},cancelDrag(){this.drag=null;},placeSelected(){assert.fail('extension consumed click');}});
  c.pointerUp({pointerId:1,clientX:115,clientY:227});assert.deepEqual(received,{x:.5,y:.5});
  c.drag={id:1,moved:true};c.pointerUp({pointerId:1,clientX:115,clientY:227});assert.equal(calls,1);
});
test('favorites remain client-writable for players while custom pin writes stay GM-gated',async()=>{
  let saved;
  const c=Object.create(AtlasMapController.prototype);
  Object.assign(c,{byId:new Map([['place',{}]]),favoriteIds:new Set(),adapters:{isGM:()=>false,saveFavorites:async value=>{saved=value;}},renderResults(){},renderDetails(){},setStatus(){},error(){}});
  await c.toggleFavorite('place');assert.deepEqual(saved,['place']);assert.equal(c.canWrite(),false);
});
test('projected marker coordinates override the reference dataset without mutation',()=>{
  const location={id:'place',mapMarkers:[{x:.1,y:.2,code:'old'}]};
  const c=Object.create(AtlasMapController.prototype);c.dataset={mapMarkers:{place:[{x:.8,y:.9,code:'new',kind:'campaign'}]}};c.customPins={};
  assert.equal(c.getMarkers(location)[0].x,.8);assert.equal(location.mapMarkers[0].x,.1);
});
test('import passes raw JSON to the host and rejects oversized files before reading',async()=>{
  let received,read=false,operation;
  const c=controls({isGM:()=>true,handleField(){},adapters:{importData:async raw=>{received=raw;}},run:task=>{operation=task();return operation;}});
  c.handleChange({target:{matches:()=>true,files:[{size:2,text:async()=>'{"format":"test"}'}]}});await operation;assert.equal(received,'{"format":"test"}');
  c.handleChange({target:{matches:()=>true,files:[{size:2*1024*1024+1,text:async()=>{read=true;}}]}});await assert.rejects(operation,/2 МБ/);assert.equal(read,false);
});

test('editing a base name and position does not copy an unchanged long reference description',async()=>{
  const location={id:'wiki-long',name:'Исходное',description:'Т'.repeat(39941),district:'Район',mapMarkers:[{x:.2,y:.3}]};let saved;
  const c=controls({state:{places:{}},map:{byId:new Map([[location.id,location]]),getMarkers:l=>l.mapMarkers},render(){},setClickMode(){},run:task=>task(),adapters:{execute:async(op,payload)=>{saved={op,payload};return applyCityOperation(emptyCity(),op,payload,{isGM:true,baseIds:new Set([location.id])});}}});
  c.handleGMAction('detail-edit',location.id);c.placeDraft.name='Новое название';c.placeDraft.x=.8;
  await c.savePlace();
  assert.equal(saved.op,'override.save');assert.deepEqual(saved.payload,{id:'wiki-long',name:'Новое название',x:.8,y:.3});
  assert.equal(location.description.length,39941);assert.equal(location.name,'Исходное');
});
test('partial base patches preserve intentional clearing, protection and market changes',()=>{
  const original={id:'wiki-place',name:'Место',description:'Описание',protected:true,market:{part:'bodega',id:'shop'},x:.2,y:.3};
  assert.deepEqual(changedPlaceFields({...original,description:'',protected:false,market:null},original),{id:'wiki-place',description:'',protected:false,market:null});
  assert.deepEqual(changedPlaceFields({...original,market:{id:'shop',part:'bodega'}},original),{id:'wiki-place'});
});
test('unchanged base save does not execute a world write',async()=>{
  const location={id:'wiki-place',name:'Место',description:'Описание',mapMarkers:[]};
  const c=controls({state:{places:{}},map:{byId:new Map([[location.id,location]]),getMarkers:l=>l.mapMarkers},render(){},setClickMode(){},adapters:{execute:()=>assert.fail('unchanged fields must not be written')}});
  c.handleGMAction('detail-edit',location.id);await c.savePlace();assert.equal(c.placeDraft,null);assert.equal(c.message,'Изменений нет.');
});
test('linked job statuses have Russian labels and a safe unknown fallback',()=>{
  assert.equal(jobStatusLabel('planned'),'Запланировано');assert.equal(jobStatusLabel('active'),'В работе');assert.equal(jobStatusLabel('blocked'),'Приостановлено');assert.equal(jobStatusLabel('done'),'Завершено');assert.equal(jobStatusLabel('archived'),'Архив');assert.equal(jobStatusLabel('__proto__'),'Неизвестный статус');
});
