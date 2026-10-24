import { routeMetrics, shortestRoadRoute } from './routes.js';
import { THREAT_LABELS, isNightHour, maxThreat, rollGig, rollStreetEncounter, threatAt } from './street-life.js';

const MODES=[['walk','Пешком'],['bike','Велосипед'],['car','Автомобиль'],['av','Аэродин']];
const THREATS=[['moderate','Умеренная'],['combat','Боевая'],['hot','Горячая']];
const TIMES=[['any','Любое время'],['day','День'],['night','Ночь']];
const ROLL_THREATS=[['any','По месту на карте'],['safe','Корпоративная'],...THREATS];
const ROLL_TIMES=[['any','По игровым часам'],['day','День'],['night','Ночь']];
const SVG='http://www.w3.org/2000/svg';
const pointOK=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1;
const copyPoint=p=>({x:p.x,y:p.y});
const uid=()=>globalThis.crypto?.randomUUID?.()??`city-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const el=(tag,cls='',text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
const svg=(tag,attrs)=>{const n=document.createElementNS(SVG,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n;};
const JOB_LABELS=Object.freeze({planned:'Запланировано',active:'В работе',blocked:'Приостановлено',done:'Завершено',archived:'Архив'});
export const jobStatusLabel=status=>Object.hasOwn(JOB_LABELS,status)?JOB_LABELS[status]:'Неизвестный статус';
const placeSnapshot=d=>{
  const record={name:String(d.name??'').trim(),description:d.description??'',district:d.district??'',category:d.category??'',image:d.image??'',protected:Boolean(d.protected),market:d.market??null,scene:d.scene??''};
  if(d.id)record.id=d.id;if(d.x!==''&&d.x!=null&&d.y!==''&&d.y!=null){record.x=Number(d.x);record.y=Number(d.y);}return record;
};
/** Preserve reference text and concurrent unrelated edits by sending only changed fields. */
export function changedPlaceFields(record,original={}){
  const patch={id:record.id};
  for(const[key,value]of Object.entries(record)){
    if(key==='id')continue;
    const previous=original[key];
    const equal=key==='market'?(value==null&&previous==null)||(value?.part===previous?.part&&value?.id===previous?.id):Object.is(value,previous);
    if(!equal)patch[key]=value;
  }
  // Coordinate updates are a pair, even if only one axis changed.
  if('x'in patch||'y'in patch){patch.x=record.x;patch.y=record.y;}
  return patch;
}

/** Authored text preview only; no actors, tokens or messages are created. */
export function chooseEncounter(entries,{threat='any',time='any',random=Math.random}={}){
  const pool=(Array.isArray(entries)?entries:[]).filter(e=>e&&typeof e.title==='string'&&(threat==='any'||e.threat==='any'||e.threat===threat)&&(time==='any'||e.time==='any'||e.time===time));
  return pool.length?pool[Math.floor(Math.max(0,Math.min(.999999999,Number(random())||0))*pool.length)]:null;
}
export function zoneRectangle(a,b){
  if(!pointOK(a)||!pointOK(b))return null;
  const width=Math.abs(a.x-b.x),height=Math.abs(a.y-b.y);
  return width<.00001||height<.00001?null:{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width,height};
}

/** UI adapter: world validation, permissions and confirmations belong to the host. */
export class CityControls{
  constructor(root,mapController,adapters={}){
    this.root=root;this.map=mapController;this.adapters=adapters;this.abort=new AbortController();this.destroyed=false;
    this.panel=root.querySelector('[data-role="city-tools"]');
    if(!this.panel){this.panel=el('section','nc-city');this.panel.dataset.role='city-tools';root.querySelector('.nc-atlas__header')?.after(this.panel);}
    this.open=false;this.tab='route';this.clickMode=null;this.anchor=null;this.route=[];this.mode='walk';this.followRoads=false;this.busy=false;this.message='';this.openSections=new Set();
    this.placeDraft=null;this.zoneDraft={name:'Зона',threat:'moderate'};this.encounterDraft={title:'',text:'',threat:'moderate',time:'any'};this.previewFilter={threat:'any',time:'any',book:true};
    this.overlay=svg('svg',{class:'nc-city__overlay','aria-hidden':'true',preserveAspectRatio:'none'});
    this.positions=el('div','nc-city__positions');this.positions.setAttribute('aria-hidden','true');this.map.nodes.stage.append(this.overlay,this.positions);
    this.previousHooks={onSelect:this.map.adapters.onSelect,onMapClick:this.map.adapters.onMapClick,decorateDetails:this.map.adapters.decorateDetails};
    this.hooks={onSelect:location=>{this.previousHooks.onSelect?.(location);this.onSelect(location);},onMapClick:point=>this.onMapClick(point)||this.previousHooks.onMapClick?.(point)===true,decorateDetails:(location,container)=>{this.previousHooks.decorateDetails?.(location,container);this.decorateDetails(location,container);}};
    Object.assign(this.map.adapters,this.hooks);
    root.addEventListener('click',event=>this.handleClick(event),{signal:this.abort.signal});
    root.addEventListener('input',event=>this.handleField(event),{signal:this.abort.signal});
    root.addEventListener('change',event=>this.handleChange(event),{signal:this.abort.signal});
    root.addEventListener('keydown',event=>{if(event.key==='Escape'&&this.clickMode){event.preventDefault();event.stopPropagation();this.setClickMode(null);}},{capture:true,signal:this.abort.signal});
    this.update();this.map.renderDetails();
  }
  isGM(){return Boolean(this.adapters.isGM?.());}
  update(view){
    if(this.destroyed)return;this.state=view?.state??(view?.schemaVersion?view:null)??this.adapters.getState?.()??{};this.positionSnapshot=view?.positions??null;
    if(!this.isGM()&&this.tab==='gm')this.tab='route';this.render();this.renderOverlay();this.updateNight();
  }
  hour(){try{const hour=this.adapters.clockHour?.();return Number.isFinite(hour)?hour:null;}catch{return null;}}
  night(){return isNightHour(this.hour());}
  updateNight(){const on=Boolean(this.adapters.nightMode?.())&&this.night();this.map.nodes.viewport.classList.toggle('is-night',on);}
  /** District of the nearest place marker: gangs and default threat follow it. */
  districtNear(point){let best=Infinity,district='';for(const location of this.map.dataset.locations??[])for(const marker of location.mapMarkers??[]){if(!pointOK(marker))continue;const d=Math.hypot(marker.x-point.x,marker.y-point.y);if(d<best&&location.district){best=d;district=location.district;}}return district;}
  rollEncounter({point=null,district='',threat}={}){
    const filter=this.previewFilter,where=point??this.state.crew??null,place=district||(where?this.districtNear(where):'');
    const level=threat??(filter.threat!=='any'?filter.threat:threatAt(where,{zones:this.state.zones??[],district:place}));
    const night=filter.time==='any'?this.night():filter.time==='night';
    this.encounterPreview=rollStreetEncounter({threat:level,night,district:place,authored:this.state.encounters??[],useBook:filter.book!==false,players:this.adapters.crewSize?.()??1});
    this.open=true;this.tab='gm';this.openSections.add('Встречи');this.panel.querySelector('details[data-city-section="Встречи"]')?.setAttribute('open','');
    this.setMessage(this.encounterPreview?'Встреча готова: покажите её или выставьте участников на сцену.':'Под выбранные условия нет авторских встреч. Включите книжные таблицы.');this.render();this.panel.querySelector('.nc-city__body')?.scrollTo?.({top:0});
  }
  renderEncounter(){
    const e=this.encounterPreview,card=el('div','nc-city__preview nc-city__encounter');if(!e)return card;
    const meta=[e.roll?`${e.threat==='combat'?'к6+4':e.threat==='hot'||e.threat==='safe'?'к6':'к10'}: ${e.roll}`:'своя встреча',THREAT_LABELS[e.threat],e.night?'ночь':'день',e.district,e.gang&&e.gang!=='местная банда'?`банда: ${e.gang}`:''].filter(Boolean).join(' · ');
    card.append(el('span','nc-city__encounter-meta',meta),el('strong','',e.title),el('p','',e.text));
    if(e.stats&&e.stats!=='—')card.append(el('p','nc-city__encounter-stats',`Статы: ${e.stats}`));if(e.twist)card.append(el('p','nc-city__encounter-twist',`Поворот (к6: ${e.twistRoll}): ${e.twist}`));
    if(e.cast?.length)card.append(el('p','nc-city__note',`На сцену: ${e.cast.map(c=>`${c.name}${c.count>1?` ×${c.count}`:''}`).join(', ')}`));
    card.append(this.row(this.button('encounter-roll','Ещё раз'),this.button('encounter-gm','Мастеру в чат',{disabled:!this.adapters.postEncounter}),this.button('encounter-reveal','Показать игрокам',{disabled:!this.adapters.postEncounter}),this.button('encounter-spawn','На сцену',{kind:'is-primary',disabled:!this.adapters.spawnEncounter||(!e.cast?.length&&!e.mooks?.length)})));
    return card;
  }
  button(action,label,{id,title,disabled=false,kind=''}={}){
    const b=el('button',`nc-city__button ${kind}`,label);b.type='button';b.dataset.cityAction=action;if(id!==undefined)b.dataset.id=String(id);if(title)b.title=title;b.disabled=disabled||this.busy;return b;
  }
  field(label,name,value,{scope='place',type='text',choices,min,max,step,wide=false}={}){
    const wrap=el('label',`nc-city__field${wide?' is-wide':''}`);wrap.append(el('span','',label));
    const input=el(choices?'select':type==='textarea'?'textarea':'input');input.dataset.cityField=name;input.dataset.scope=scope;
    if(choices){for(const[v,text]of choices){const option=el('option','',text);option.value=String(v);input.append(option);}input.value=String(value??'');}
    else if(type==='textarea'){input.value=String(value??'');input.rows=3;}
    else{input.type=type;if(type==='checkbox')input.checked=Boolean(value);else input.value=String(value??'');if(min!==undefined)input.min=min;if(max!==undefined)input.max=max;if(step!==undefined)input.step=step;}
    input.disabled=this.busy;wrap.append(input);return wrap;
  }
  row(...children){const n=el('div','nc-city__row');n.append(...children);return n;}
  note(text){return el('p','nc-city__note',text);}
  section(title){const n=el('section','nc-city__section');n.append(el('h3','',title));return n;}
  details(title){const n=el('details','nc-city__section');n.dataset.citySection=title.split(' ·')[0];n.open=this.openSections.has(n.dataset.citySection);n.append(el('summary','',title));return n;}
  selected(){return this.map.byId.get(this.map.state.selectedId);}
  setMessage(text){this.message=String(text??'');const n=this.panel.querySelector('[data-city-status]');if(n)n.textContent=this.message;this.map.setStatus(this.message);}
  setClickMode(mode){
    this.clickMode=mode;this.anchor=null;this.map.cancelPlacement();this.map.nodes.viewport.classList.toggle('is-city-placing',Boolean(mode));
    const help={route:'Маршрут: щёлкайте по карте. Перетаскивание двигает карту; Esc завершает.',personal:'Щёлкните для личной метки. Esc — отмена.',crew:'Щёлкните, чтобы переместить группу. Esc — отмена.',road:'Укажите два конца участка дороги. Esc — отмена.',zone:'Укажите два противоположных угла зоны. Esc — отмена.',place:'Щёлкните, чтобы задать координаты места. Esc — отмена.'};
    this.setMessage(help[mode]??'Режим постановки завершён.');this.render();this.renderOverlay();
  }
  resolvedRoute(){
    if(!this.followRoads||this.route.length<2)return{points:this.route,warnings:[],valid:true};
    if(this.route.length>64)return{points:[],warnings:['Для нового расчёта по дорогам оставьте не больше 64 опорных точек. Общий путь можно использовать без повторного расчёта.'],valid:false};
    const points=[this.route[0]],warnings=[];
    for(let i=1;i<this.route.length;i++){
      let result;try{result=shortestRoadRoute(this.route[i-1],this.route[i],this.state.roads??[],{mapWidth:this.map.dataset.map.width,mapHeight:this.map.dataset.map.height});}catch(error){return{points:[],warnings:[error.message],valid:false};}
      if(!result?.points?.length)return{points:[],warnings:[result?.reason||'Путь по дорогам не найден. Соедините участки или выключите режим дорог.'],valid:false};
      points.push(...result.points.slice(1));if(result.reason)warnings.push(result.reason);if(result.connectorSegments?.length)warnings.push('Начало или конец соединены с дорогой прямым отрезком.');
      if(points.length>1003)return{points:[],warnings:['Получившийся путь слишком длинный. Уменьшите число опорных точек.'],valid:false};
    }return{points,warnings:[...new Set(warnings)],valid:true};
  }
  metrics(points){return routeMetrics(points,{...this.state.config,mode:this.mode,zones:this.state.zones??[],mapWidth:this.map.dataset.map.width,mapHeight:this.map.dataset.map.height});}
  render(){
    if(this.destroyed)return;
    const active=document.activeElement,focus=active?.dataset.cityField?{field:active.dataset.cityField,scope:active.dataset.scope,start:active.selectionStart,end:active.selectionEnd}:null;
    for(const section of this.panel.querySelectorAll('details[data-city-section]')){if(section.open)this.openSections.add(section.dataset.citySection);else this.openSections.delete(section.dataset.citySection);}
    this.panel.hidden=!this.open;for(const b of this.root.querySelectorAll('[data-city-action="toggle"]'))b.setAttribute('aria-expanded',String(this.open));
    const nav=el('nav','nc-city__tabs');nav.setAttribute('aria-label','Инструменты города');
    for(const[id,label]of[['route','Маршрут'],['places','Места'],...(this.isGM()?[['gm','Мастер']]:[])]){const b=this.button('tab',label,{id});b.setAttribute('aria-pressed',String(this.tab===id));nav.append(b);}nav.append(el('span','nc-city__clock',this.adapters.clock?.()??''));
    const body=el('div','nc-city__body');if(this.tab==='route')this.renderRoute(body);else if(this.tab==='places')this.renderPlaces(body);else this.renderGM(body);
    const status=el('p','nc-city__status',this.message);status.dataset.cityStatus='';status.setAttribute('role','status');this.panel.replaceChildren(nav,body,status);
    if(focus){const input=[...this.panel.querySelectorAll('[data-city-field]')].find(n=>n.dataset.cityField===focus.field&&n.dataset.scope===focus.scope);input?.focus({preventScroll:true});if(input&&typeof input.setSelectionRange==='function'&&focus.start!=null){try{input.setSelectionRange(focus.start,focus.end);}catch{}}}
  }
  renderRoute(body){
    const route=this.resolvedRoute();let metrics;try{metrics=this.metrics(route.points);}catch(error){metrics={distanceKm:0,minutes:0,warnings:[error.message]};}
    const controls=this.section('План пути');controls.append(this.row(this.field('Передвижение','mode',this.mode,{scope:'route',choices:MODES}),this.field('По нарисованным дорогам','followRoads',this.followRoads,{scope:'route',type:'checkbox'})));
    controls.append(this.row(this.button('draw-route',this.clickMode==='route'?'Завершить точки':'Точки на карте',{kind:this.clickMode==='route'?'is-active':''}),this.button('route-undo','Назад',{disabled:!this.route.length}),this.button('route-clear','Очистить',{disabled:!this.route.length}),this.button('route-place','Добавить выбранное место',{disabled:!this.selected()||!this.map.getMarkers(this.selected()).length})));
    const summary=el('div','nc-city__metrics');summary.append(el('strong','',`≈ ${Number(metrics.distanceKm||0).toFixed(2)} км`),el('strong','',`≈ ${Math.ceil(Number(metrics.minutes)||0)} мин`),el('span','',`${this.route.length} точек · ширина карты ${this.state.config?.widthKm??20} км`));controls.append(summary);
    for(const warning of[...route.warnings,...(metrics.warnings??[])])controls.append(this.note(typeof warning==='string'?warning:warning.message??warning.name??'Маршрут пересекает зону угрозы.'));
    controls.append(this.note('Расстояние и время приблизительные. Дороги задаёт Мастер; расчёт не учитывает пробки.'));
    const actions=this.section('Позиции и общий маршрут');actions.append(this.row(this.button('personal','Моя метка',{kind:this.clickMode==='personal'?'is-active':''}),this.button('personal-clear','Убрать мою метку'),this.button('shared-copy','Взять общий маршрут',{disabled:!this.state.sharedRoute?.points?.length})));
    if(this.isGM())actions.append(this.row(this.button('crew','Поставить группу',{kind:this.clickMode==='crew'?'is-active':''}),this.button('publish','Показать маршрут всем',{disabled:!route.valid||route.points.length<2}),this.button('unpublish','Скрыть общий маршрут',{disabled:!this.state.sharedRoute?.points?.length}),this.button('travel','Переместить группу и время…',{disabled:!route.valid||route.points.length<2,kind:'is-primary'}),this.button('route-encounter','Встреча в пути',{disabled:route.points.length<2})));
    actions.append(this.row(this.button('agent-map','Карта в Агенте',{disabled:!this.adapters.openAgent}),this.button('agent-jobs','Задания в Агенте',{disabled:!this.adapters.openAgent})),this.note('Общие данные города доступны участникам. Личный план публикуется только отдельной командой Мастера.'));body.append(controls,actions);
  }
  renderPlaces(body){
    const location=this.selected(),info=this.section(location?.name??'Выберите место');info.append(this.note(location?'Описание и действия находятся в карточке справа. Базовое место изменяется отдельной поправкой.':'Выберите место в каталоге или создайте своё.'));
    if(this.isGM())info.append(this.row(this.button('new-place','Новое место'),this.button('edit-place','Изменить выбранное',{disabled:!location})));
    if(!this.isGM()){info.append(this.note('Избранное и личная позиция доступны каждому. Общие места изменяет Мастер.'));body.append(info);return;}
    if(this.placeDraft){
      const d=this.placeDraft,editor=this.section(d.id?'Редактор места':'Новое место'),grid=el('div','nc-city__grid');
      grid.append(this.field('Название','name',d.name),this.field('Район','district',d.district),this.field('Категория','category',d.category),this.field('Описание','description',d.description,{type:'textarea',wide:true}),this.field('Изображение','image',d.image,{wide:true}),this.field('X · 0…1','x',d.x,{type:'number',min:0,max:1,step:.0001}),this.field('Y · 0…1','y',d.y,{type:'number',min:0,max:1,step:.0001}),this.field('Защитить от удаления','protected',d.protected,{type:'checkbox'}));
      let shops=[];try{shops=this.adapters.listShops?.()??[];}catch{}
      const choices=[['','Без торговой точки'],...shops.map(s=>[`${s.part}:${s.id}`,s.name])];if(d.market&&!choices.some(([key])=>key===`${d.market.part}:${d.market.id}`))choices.push([`${d.market.part}:${d.market.id}`,'Сохранённая связь (точка недоступна)']);
      grid.append(this.field('Торговая точка','market',d.market?`${d.market.part}:${d.market.id}`:'',{choices,wide:true}));
      let scenes=[];try{scenes=this.adapters.listScenes?.()??[];}catch{}
      const sceneChoices=[['','Без сцены'],...scenes.map(s=>[s.id,s.name])];if(d.scene&&!sceneChoices.some(([key])=>key===d.scene))sceneChoices.push([d.scene,'Сохранённая сцена (удалена)']);
      grid.append(this.field('Сцена места (боевая карта)','scene',d.scene??'',{choices:sceneChoices,wide:true}));editor.append(grid);
      editor.append(this.row(this.button('place-position','Координаты на карте',{kind:this.clickMode==='place'?'is-active':''}),this.button('pick-image','Выбрать изображение',{disabled:!this.adapters.pickImage}),this.button('save-place','Сохранить место',{kind:'is-primary'}),this.button('cancel-place','Отмена')));
      if(d.id){if(d.isBase)editor.append(this.row(this.button('hide-place','Скрыть базовое место',{disabled:d.protected}),this.button('reset-place','Восстановить исходное')));else editor.append(this.row(this.button('remove-place','Удалить своё место',{disabled:d.protected})));}info.append(editor);
    }
    const hidden=Object.entries(this.state.overrides??{}).filter(([,o])=>o.hidden);if(hidden.length){const restore=this.details(`Скрытые базовые места · ${hidden.length}`);for(const[id,o]of hidden)restore.append(this.row(el('span','nc-city__item-name',o.name||id),this.button('restore-place','Показать снова',{id})));info.append(restore);}
    info.append(this.note('Общие данные города доступны участникам. Не сохраняйте здесь секретные заметки или переписку.'));body.append(info);
  }
  renderGM(body){
    if(!this.isGM())return;
    const roads=this.details(`Дороги · ${(this.state.roads??[]).length} участков`);roads.open ||= this.clickMode==='road';
    roads.append(this.note('Один участок — два щелчка. Для соединения дорог щёлкайте рядом с концом существующего участка.'),this.row(this.button('road-mode',this.clickMode==='road'?'Завершить дороги':'Нарисовать участок',{kind:this.clickMode==='road'?'is-active':''}),this.button('road-undo','Убрать последний',{disabled:!this.state.roads?.length}),this.button('road-clear','Очистить дороги',{disabled:!this.state.roads?.length})));
    const zones=this.details(`Зоны угрозы · ${(this.state.zones??[]).length}`);zones.open ||= this.clickMode==='zone';
    zones.append(this.row(this.field('Название зоны','name',this.zoneDraft.name,{scope:'zone'}),this.field('Угроза','threat',this.zoneDraft.threat,{scope:'zone',choices:THREATS})),this.button('zone-mode',this.clickMode==='zone'?'Завершить зону':'Прямоугольник на карте',{kind:this.clickMode==='zone'?'is-active':''}));
    for(const z of this.state.zones??[])zones.append(this.row(el('span','nc-city__item-name',`${z.name} · ${THREATS.find(([id])=>id===z.threat)?.[1]??z.threat}`),this.button('zone-remove','Убрать',{id:z.id})));
    const config=this.details('Масштаб и скорости'),settings=this.configDraft??this.state.config??{},grid=el('div','nc-city__grid');
    grid.append(this.field('Ширина карты, км','widthKm',settings.widthKm??20,{scope:'config',type:'number',min:.01,step:.1}));
    for(const[id,label]of MODES)grid.append(this.field(`${label}, км/ч`,id,settings.speeds?.[id]??({walk:5,bike:18,car:35,av:100}[id]),{scope:'config',type:'number',min:.1,step:.1}));config.append(grid,this.button('config-save','Сохранить масштаб'));
    const encounters=this.details(`Встречи · своих ${(this.state.encounters??[]).length}`),e=this.encounterDraft,form=el('div','nc-city__grid');
    form.append(this.field('Название встречи','title',e.title,{scope:'encounter'}),this.field('Угроза','threat',e.threat,{scope:'encounter',choices:[['any','Любая угроза'],...THREATS]}),this.field('Время','time',e.time,{scope:'encounter',choices:TIMES}),this.field('Описание','text',e.text,{scope:'encounter',type:'textarea',wide:true}));
    encounters.append(form,this.row(this.button('encounter-save',e.id?'Сохранить встречу':'Добавить встречу'),this.button('encounter-new','Очистить форму')));
    for(const entry of this.state.encounters??[])encounters.append(this.row(el('span','nc-city__item-name',entry.title),this.button('encounter-edit','Изменить',{id:entry.id}),this.button('encounter-remove','Удалить',{id:entry.id})));
    encounters.append(this.row(this.field('Угроза','threat',this.previewFilter.threat,{scope:'preview',choices:ROLL_THREATS}),this.field('Время','time',this.previewFilter.time,{scope:'preview',choices:ROLL_TIMES}),this.field('Книжные таблицы (Корка)','book',this.previewFilter.book!==false,{scope:'preview',type:'checkbox'}),this.button('encounter-roll','Случайная встреча',{kind:'is-primary'})));
    encounters.append(this.note('Угроза «по месту» берётся из зон Мастера, иначе из района ближайшего места к группе. Свои встречи смешиваются с книжными; «На сцену» выставляет скрытые токены из компендиума «Найт-Сити · персонажи» (или Night City Gang & Corp Mook Pack, если он установлен).'));
    const transfer=this.details('Экспорт и импорт города');transfer.append(this.note('Общие данные города доступны участникам. Импорт проходит проверку и подтверждение Мастера.'),this.row(this.button('export','Экспорт JSON',{disabled:!this.adapters.exportData}),this.button('import','Импорт JSON…',{disabled:!this.adapters.importData})));
    const input=el('input');input.type='file';input.accept='.json,application/json';input.hidden=true;input.dataset.cityImport='';transfer.append(input);
    if(this.encounterPreview)body.append(this.renderEncounter());body.append(roads,zones,config,encounters,transfer);
  }
  handleField(event){
    const input=event.target.closest('[data-city-field]');if(!input||!this.root.contains(input))return;
    const{cityField:field,scope}=input.dataset,value=input.type==='checkbox'?input.checked:input.value;
    if(scope==='place'&&this.placeDraft){if(field==='market'){const index=String(value).indexOf(':');this.placeDraft.market=index<0?null:{part:value.slice(0,index),id:value.slice(index+1)};}else this.placeDraft[field]=value;}
    else if(scope==='zone')this.zoneDraft[field]=value;
    else if(scope==='encounter')this.encounterDraft[field]=value;
    else if(scope==='preview')this.previewFilter[field]=value;
    else if(scope==='config'){this.configDraft??=structuredClone(this.state.config??{widthKm:20,speeds:{walk:5,bike:18,car:35,av:100}});if(field==='widthKm')this.configDraft.widthKm=Number(value);else{this.configDraft.speeds??={};this.configDraft.speeds[field]=Number(value);}}
  }
  handleChange(event){
    this.handleField(event);
    if(event.target.matches('[data-city-import]')){const file=event.target.files?.[0];if(file&&this.isGM())void this.run(async()=>{if(file.size>2*1024*1024)throw Error('Файл больше 2 МБ.');await this.adapters.importData?.(await file.text());},'Импорт обработан.');return;}
    if(event.target.dataset.scope==='route'){if(event.target.dataset.cityField==='mode')this.mode=event.target.value;else this.followRoads=event.target.checked;this.render();this.renderOverlay();}
  }
  handleClick(event){
    const button=event.target.closest('[data-city-action]');if(!button||!this.root.contains(button)||button.disabled)return;
    event.preventDefault();const action=button.dataset.cityAction,id=button.dataset.id;
    if(action==='toggle'){this.open=!this.open;if(!this.open)this.setClickMode(null);this.render();return;}
    if(action==='tab'){this.open=true;this.tab=id;this.setClickMode(null);this.render();return;}if(this.busy)return;
    if(action==='draw-route')this.setClickMode(this.clickMode==='route'?null:'route');
    else if(action==='route-undo'){this.route.pop();this.render();this.renderOverlay();}
    else if(action==='route-clear'){this.route=[];this.setClickMode(null);}
    else if(action==='route-place'||action==='detail-route'){const loc=id?this.map.byId.get(id):this.selected(),p=loc&&this.map.getMarkers(loc)[0];if(p&&this.route.length<64){this.route.push(copyPoint(p));this.open=true;this.tab='route';this.render();this.renderOverlay();}else if(this.route.length>=64)this.setMessage('В плане уже 64 точки. Удалите лишние.');}
    else if(action==='personal')this.setClickMode(this.clickMode==='personal'?null:'personal');
    else if(action==='personal-clear')void this.run(()=>this.adapters.setPersonalPosition?.(null),'Личная метка убрана.');
    else if(action==='shared-copy'){this.route=(this.state.sharedRoute?.points??[]).filter(pointOK).map(copyPoint);this.mode=this.state.sharedRoute?.mode??'walk';this.followRoads=false;this.render();this.renderOverlay();}
    else if(action==='agent-map'||action==='agent-jobs')void this.run(()=>this.adapters.openAgent?.(action==='agent-map'?'map':'jobs'));
    else if(action==='market'){const location=this.map.byId.get(id);if(location?.market)void this.run(()=>this.adapters.openMarket?.(location.market));}
    else if(action==='job')void this.run(()=>this.adapters.openJob?.(id));
    else if(action==='import'&&this.isGM())this.panel.querySelector('[data-city-import]')?.click();
    else if(action==='export'&&this.isGM())void this.run(()=>this.adapters.exportData?.());
    else if(this.isGM())this.handleGMAction(action,id);
  }
  handleGMAction(action,id){
    if(action==='crew')this.setClickMode(this.clickMode==='crew'?null:'crew');
    else if(action==='publish'){const route=this.resolvedRoute();if(!route.valid||route.points.length<2){this.setMessage(route.warnings[0]||'Добавьте хотя бы две точки.');return;}void this.command('route.publish',{points:route.points,mode:this.mode},'Маршрут показан участникам.');}
    else if(action==='unpublish')void this.command('route.publish',{points:[],mode:this.mode},'Общий маршрут скрыт.');
    else if(action==='travel'){const route=this.resolvedRoute();if(!route.valid||route.points.length<2){this.setMessage(route.warnings[0]||'Добавьте хотя бы две точки.');return;}void this.run(()=>this.adapters.travel?.(route.points,this.mode));}
    else if(action==='draft-job'){const location=this.map.byId.get(id);if(location)void this.run(()=>this.adapters.draftJobForLocation?.(location));}
    else if(action==='dossier'){const location=this.map.byId.get(id);if(location)void this.run(()=>this.adapters.showDossier?.(location));}
    else if(action==='new-place'){this.placeOriginal=null;this.placeDraft={name:'',description:'',district:'',category:'',image:'',x:'',y:'',protected:false,market:null};this.open=true;this.tab='places';this.render();}
    else if(action==='edit-place'||action==='detail-edit'){const location=id?this.map.byId.get(id):this.selected();if(location){const p=this.map.getMarkers(location)[0];this.placeDraft={...location,x:p?.x??'',y:p?.y??'',isBase:!Object.hasOwn(this.state.places??{},location.id),market:location.market??null};this.placeOriginal=structuredClone(placeSnapshot(this.placeDraft));this.open=true;this.tab='places';this.render();}}
    else if(action==='cancel-place'){this.placeDraft=null;this.setClickMode(null);}
    else if(action==='place-position')this.setClickMode(this.clickMode==='place'?null:'place');
    else if(action==='pick-image')void this.run(async()=>{const path=await this.adapters.pickImage?.();if(path&&this.placeDraft)this.placeDraft.image=path;});
    else if(action==='save-place')void this.savePlace();
    else if(action==='hide-place'&&this.placeDraft?.id)void this.command('override.save',{id:this.placeDraft.id,hidden:true},'Базовое место скрыто.');
    else if(action==='restore-place')void this.command('override.save',{id,hidden:false},'Место снова показано.');
    else if(action==='reset-place'&&this.placeDraft?.id)void this.run(async()=>{await this.adapters.execute('override.reset',{id:this.placeDraft.id});this.placeDraft=null;},'Исходное место восстановлено.');
    else if(action==='remove-place'&&this.placeDraft?.id)void this.run(async()=>{await this.adapters.execute('place.remove',{id:this.placeDraft.id});this.placeDraft=null;},'Своё место удалено.');
    else if(action==='road-mode')this.setClickMode(this.clickMode==='road'?null:'road');
    else if(action==='road-undo')void this.command('roads.set',{roads:(this.state.roads??[]).slice(0,-1)},'Последний участок убран.');
    else if(action==='road-clear')void this.command('roads.set',{roads:[]},'Дороги очищены.');
    else if(action==='zone-mode')this.setClickMode(this.clickMode==='zone'?null:'zone');
    else if(action==='zone-remove')void this.command('zones.set',{zones:(this.state.zones??[]).filter(z=>z.id!==id)},'Зона убрана.');
    else if(action==='config-save')void this.run(async()=>{await this.adapters.execute('config.set',{config:this.configDraft??this.state.config});this.configDraft=null;},'Масштаб сохранён.');
    else if(action==='encounter-save')void this.run(async()=>{const d={...this.encounterDraft,id:this.encounterDraft.id||uid()};if(!d.title.trim()||!d.text.trim())throw Error('Заполните название и описание встречи.');await this.adapters.execute('encounters.set',{encounters:[...(this.state.encounters??[]).filter(e=>e.id!==d.id),d]});this.encounterDraft={title:'',text:'',threat:'moderate',time:'any'};},'Встреча сохранена.');
    else if(action==='encounter-new'){this.encounterDraft={title:'',text:'',threat:'moderate',time:'any'};this.render();}
    else if(action==='encounter-edit'){const e=(this.state.encounters??[]).find(e=>e.id===id);if(e){this.encounterDraft={...e};this.render();}}
    else if(action==='encounter-remove')void this.command('encounters.set',{encounters:(this.state.encounters??[]).filter(e=>e.id!==id)},'Встреча удалена.');
    else if(action==='encounter-roll')this.rollEncounter();
    else if(action==='encounter-here'){const location=this.map.byId.get(id),p=location&&this.map.getMarkers(location)[0];if(p)this.rollEncounter({point:p,district:location.district??''});else this.setMessage('У места нет точки на карте.');}
    else if(action==='route-encounter'){const route=this.resolvedRoute(),points=route.points.filter(pointOK);if(points.length<2){this.setMessage('Сначала составьте маршрут.');return;}const step=Math.max(1,Math.floor(points.length/24)),samples=points.filter((_,i)=>i%step===0).concat(points.at(-1));const end=points.at(-1),district=this.districtNear(end);const threat=this.previewFilter.threat!=='any'?this.previewFilter.threat:maxThreat(samples.map(p=>threatAt(p,{zones:this.state.zones??[],district:this.districtNear(p)})));this.rollEncounter({point:end,district,threat});}
    else if(action==='encounter-gm'||action==='encounter-reveal')void this.run(()=>this.adapters.postEncounter?.(this.encounterPreview,{reveal:action==='encounter-reveal'}));
    else if(action==='encounter-spawn')void this.run(()=>this.adapters.spawnEncounter?.(this.encounterPreview));
    else if(action==='gig-here'){const location=this.map.byId.get(id);if(location)void this.run(async()=>{const gig=rollGig(location,{players:this.adapters.crewSize?.()??1});await this.adapters.draftGigForLocation?.(location,gig);},'Черновик заказа открыт в «Агенте».');}
    else if(action==='scene-view'||action==='scene-activate'){const location=this.map.byId.get(id);if(location?.scene)void this.run(()=>this.adapters.openScene?.(location,{activate:action==='scene-activate'}));}
  }
  async savePlace(){
    if(!this.placeDraft)return;
    const d=this.placeDraft,record=placeSnapshot(d);
    if(d.x!==''&&d.y!==''){record.x=Number(d.x);record.y=Number(d.y);if(!pointOK(record)){this.setMessage('Координаты должны быть от 0 до 1.');return;}}
    else if(!d.isBase){this.setMessage('Укажите координаты нового места или выберите точку на карте.');return;}
    if(!record.name){this.setMessage('Введите название места.');return;}
    const payload=d.isBase?changedPlaceFields(record,this.placeOriginal):record;
    if(d.isBase&&Object.keys(payload).length===1){this.placeDraft=null;this.placeOriginal=null;this.setClickMode(null);this.setMessage('Изменений нет.');return;}
    await this.run(async()=>{await this.adapters.execute(d.isBase?'override.save':'place.save',payload);this.placeDraft=null;this.placeOriginal=null;this.setClickMode(null);},'Место сохранено.');
  }
  async command(op,payload,message){return this.run(async()=>{const next=await this.adapters.execute(op,payload);if(next?.schemaVersion)this.state=next;},message);}
  async run(task,message){
    if(this.busy||this.destroyed)return;this.busy=true;this.render();
    try{await task();if(!this.destroyed){this.state=this.adapters.getState?.()??this.state;if(message)this.setMessage(message);}}
    catch(error){if(!this.destroyed)this.setMessage(error?.message||'Действие не выполнено.');}
    finally{this.busy=false;if(!this.destroyed){this.render();this.renderOverlay();this.map.renderDetails();}}
  }
  onSelect(){if(this.open&&!this.placeDraft)this.render();}
  snapRoadPoint(point){
    const{width,height}=this.map.dataset.map;let nearest=point,best=14/Math.max(.01,this.map.view.scale);
    for(const road of this.state.roads??[])for(const p of[road.a,road.b])if(pointOK(p)){const d=Math.hypot((p.x-point.x)*width,(p.y-point.y)*height);if(d<best){nearest=p;best=d;}}return copyPoint(nearest);
  }
  onMapClick(point){
    if(!this.clickMode||!pointOK(point))return false;if(this.busy)return true;
    if(this.clickMode==='route'){if(this.route.length>=64){this.setMessage('В плане уже 64 точки. Удалите лишние.');return true;}this.route.push(copyPoint(point));this.render();this.renderOverlay();return true;}
    if(this.clickMode==='personal'){void this.run(async()=>{await this.adapters.setPersonalPosition?.(copyPoint(point));this.setClickMode(null);},'Личная позиция обновлена.');return true;}
    if(!this.isGM())return true;
    if(this.clickMode==='crew')void this.run(async()=>{await this.adapters.execute('crew.set',{point:copyPoint(point)});this.setClickMode(null);},'Позиция группы обновлена.');
    else if(this.clickMode==='place'){if(this.placeDraft){this.placeDraft.x=Number(point.x.toFixed(5));this.placeDraft.y=Number(point.y.toFixed(5));}this.setClickMode(null);}
    else if(this.clickMode==='road'){
      const p=this.snapRoadPoint(point);if(!this.anchor){this.anchor=p;this.setMessage('Начало участка выбрано. Укажите конец; близкие узлы соединяются.');this.renderOverlay();}
      else if(Math.hypot(p.x-this.anchor.x,p.y-this.anchor.y)>.00001){const road={id:uid(),a:copyPoint(this.anchor),b:p};this.anchor=null;void this.command('roads.set',{roads:[...(this.state.roads??[]),road]},'Участок добавлен. Можно указать следующий.');}
    }else if(this.clickMode==='zone'){
      if(!this.anchor){this.anchor=copyPoint(point);this.setMessage('Первый угол выбран. Укажите противоположный.');this.renderOverlay();}
      else{const rect=zoneRectangle(this.anchor,point);if(!rect){this.setMessage('Зона должна иметь ненулевую ширину и высоту.');return true;}const z={id:uid(),name:this.zoneDraft.name||'Зона',threat:this.zoneDraft.threat,...rect};this.anchor=null;void this.command('zones.set',{zones:[...(this.state.zones??[]),z]},'Зона добавлена.');}
    }return true;
  }
  decorateDetails(location,container){
    container.querySelector('.nc-city__detail-links')?.remove();container.querySelector('.nc-city__place-image')?.remove();const links=el('div','nc-city__detail-links');
    links.append(this.button('detail-route','В маршрут',{id:location.id,disabled:!this.map.getMarkers(location).length}));
    if(location.market)links.append(this.button('market','Открыть торговую точку',{id:location.id,disabled:!this.adapters.openMarket}));
    if(this.isGM())links.append(this.button('detail-edit','Изменить место',{id:location.id}),this.button('dossier','Показать участникам',{id:location.id,disabled:!this.adapters.showDossier}),this.button('draft-job','Создать заказ',{id:location.id,disabled:!this.adapters.draftJobForLocation}),this.button('gig-here','Заказ от фиксера',{id:location.id,title:'Случайный заказ с заказчиком, оплатой и осложнением — черновиком в «Агенте»',disabled:!this.adapters.draftGigForLocation}),this.button('encounter-here','Встреча здесь',{id:location.id,title:'Уличная встреча по угрозе района и времени суток',disabled:!this.map.getMarkers(location).length}));
    if(this.isGM()&&location.scene)links.append(this.button('scene-view','Открыть сцену',{id:location.id,disabled:!this.adapters.openScene}),this.button('scene-activate','Перенести игроков',{id:location.id,disabled:!this.adapters.openScene}));
    container.querySelector('.nc-atlas__detail-actions')?.after(links);
    if(location.image){const image=el('img','nc-city__place-image');image.src=location.image;image.alt=location.name??'Место';image.loading='lazy';container.querySelector('.nc-atlas__description')?.before(image);}
    container.querySelector('.nc-city__jobs')?.remove();
    if(this.adapters.jobsForLocation){const jobs=el('section','nc-city__jobs');container.append(jobs);Promise.resolve().then(()=>this.adapters.jobsForLocation(location.id)).then(entries=>{if(this.destroyed||!this.root.contains(jobs))return;if(!entries?.length){jobs.remove();return;}jobs.append(el('h3','','Связанные задания'));for(const job of entries){const row=this.row(this.button('job',job.title||'Задание',{id:job.id,disabled:!this.adapters.openJob}));if(job.status)row.append(el('span','nc-city__note',jobStatusLabel(job.status)));jobs.append(row);}}).catch(()=>{if(!this.destroyed&&this.root.contains(jobs))jobs.textContent='Связанные задания сейчас недоступны.';});}
  }
  renderOverlay(){
    if(this.destroyed)return;const{width,height}=this.map.dataset.map;this.overlay.setAttribute('viewBox',`0 0 ${width} ${height}`);this.overlay.replaceChildren();this.positions.replaceChildren();
    const line=(points,kind)=>{if(points.length>1)this.overlay.append(svg('polyline',{points:points.filter(pointOK).map(p=>`${p.x*width},${p.y*height}`).join(' '),class:kind,fill:'none','vector-effect':'non-scaling-stroke'}));};
    for(const z of this.state.zones??[])if(pointOK(z)&&Number.isFinite(z.width)&&Number.isFinite(z.height)){const rect=svg('rect',{x:z.x*width,y:z.y*height,width:z.width*width,height:z.height*height,class:`nc-city__zone is-${['moderate','combat','hot'].includes(z.threat)?z.threat:'moderate'}`,'vector-effect':'non-scaling-stroke'}),title=svg('title',{});title.textContent=z.name??'Зона';rect.append(title);this.overlay.append(rect);}
    for(const r of this.state.roads??[])if(pointOK(r.a)&&pointOK(r.b))line([r.a,r.b],'nc-city__road');line(this.state.sharedRoute?.points??[],'nc-city__shared-route');const resolved=this.resolvedRoute();line(resolved.valid?resolved.points:this.route,resolved.valid?'nc-city__route':'nc-city__route is-invalid');
    const marker=(p,name,kind)=>{if(!pointOK(p))return;const n=el('span',`nc-city__position ${kind}`,name);n.style.left=`${p.x*100}%`;n.style.top=`${p.y*100}%`;this.positions.append(n);};
    marker(this.state.crew,'Группа','is-crew');for(const p of this.positionSnapshot??this.adapters.getPositions?.()??[])marker(p,p.name||'Игрок','is-personal');if(this.anchor)marker(this.anchor,'Начало','is-anchor');this.route.forEach((p,i)=>marker(p,String(i+1),'is-route'));
  }
  destroy(){
    if(this.destroyed)return;this.destroyed=true;this.abort.abort();this.overlay.remove();this.positions.remove();this.panel.replaceChildren();this.panel.hidden=true;this.map.nodes.viewport.classList.remove('is-city-placing');
    for(const key of Object.keys(this.hooks))if(this.map.adapters[key]===this.hooks[key])this.map.adapters[key]=this.previousHooks[key];
    for(const node of this.root.querySelectorAll('.nc-city__detail-links,.nc-city__place-image,.nc-city__jobs'))node.remove();
    for(const button of this.root.querySelectorAll('[data-city-action="toggle"]'))button.setAttribute('aria-expanded','false');
  }
}
