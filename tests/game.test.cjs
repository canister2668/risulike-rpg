const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(process.env.RPG_SOURCE || 'Risulike RPG.js','utf8');
async function harness(t, body, {risu=false}={}) {
 const dom=new JSDOM('<!doctype html><body></body>',{url:'https://test.invalid',runScripts:'outside-only',pretendToBeVisual:true});
 t.after(()=>dom.window.close());
 const w=dom.window, store=new Map(), errors=[];
 w.console={log(){},warn(){},error(...args){errors.push(args.map(String).join(' '))}};
 w.report=x=>t.diagnostic(x); w.assert=assert; w.store=store; w.errors=errors;
 if(risu) w.Risuai={safeLocalStorage:{getItem:async k=>store.get('local:'+k)||null,setItem:async(k,v)=>store.set('local:'+k,v)},getArgument:async k=>store.get(k),setArgument:async(k,v)=>{await new Promise(r=>setTimeout(r,2));store.set(k,v)}};
 w.eval(source.replace('await initRPG();','globalThis.runTest = async function(){\n'+body+'\n};'));
 assert.equal(typeof w.runTest,'function',errors.join('\n'));
 await w.runTest();
}
const setup='gameState=createGameState(); player=createPlayer("warrior"); _activeSlot=1; render=function(){}; showToast=function(){};';
test('all classes create, calculate stats and render inventory',async t=>harness(t,`
 for(const k of Object.keys(PLAYER_CLASSES)) {
  gameState=createGameState(); player=createPlayer(k); recalcPlayerStats(); showInventoryTab=true;
  assert.ok(Number.isFinite(player.maxHp) && player.maxHp>0,k);
  assert.ok(renderInventory().length>100,k); assert.ok(renderPlayerStatus().length>100,k);
  for(const sk of player.skills) assert.ok(SKILL_DEFS[sk],k+':'+sk);
 }
`));
test('save snapshot survives immediate state clearing (async host)',async t=>harness(t,setup+`
 const pending=saveAll(); player=null; gameState=null; _activeSlot=0;
 assert.equal(await pending,true);
 const saved=JSON.parse(store.get(slotKey(1))); assert.equal(JSON.parse(saved.player).classKey,'warrior');
 assert.equal(JSON.parse(store.get(KEY_STATE)).floor,1);
`,{risu:true}));
test('concurrent saves preserve slot identity and latest main state',async t=>harness(t,setup+`
 player.gold=10; const a=saveAll(); _activeSlot=2; player.gold=20; gameState.floor=2; const b=saveAll();
 await Promise.all([a,b]);
 assert.equal(JSON.parse(JSON.parse(store.get(slotKey(1))).player).gold,10);
 assert.equal(JSON.parse(JSON.parse(store.get(slotKey(2))).player).gold,20);
 assert.equal(JSON.parse(store.get(KEY_STATE)).floor,2);
`,{risu:true}));
test('v1 import persists complete slot before clearing memory',async t=>harness(t,setup+`
 const p=player,g=gameState; player=null;gameState=null;
 await importSaveCode(utf8ToBase64(JSON.stringify({p,g})));
 assert.equal(JSON.parse(JSON.parse(store.get(slotKey(1))).player).classKey,'warrior');
 assert.equal(player,null);
`,{risu:true}));
test('v2 sparse-slot import does not touch slot 1',async t=>harness(t,setup+`
 const p=player,g=gameState; player=null;gameState=null;
 await importSaveCode(utf8ToBase64(JSON.stringify({v:2,slots:{3:{p,g}}})));
 assert.ok(store.get(slotKey(3))); assert.equal(store.has(slotKey(1)),false); assert.equal(player,null);
`,{risu:true}));
test('invalid slot IDs rejected before any writes',async t=>harness(t,setup+`
 const p=player,g=gameState; player=null;gameState=null;
 await importSaveCode(utf8ToBase64(JSON.stringify({v:2,slots:{1:{p,g},6:{p,g}}})));
 assert.equal(store.size,0);
`,{risu:true}));
test('invalid save in later slot cannot partially overwrite earlier slots',async t=>harness(t,setup+`
 const p=player,g=gameState; player=null;gameState=null;
 await importSaveCode(utf8ToBase64(JSON.stringify({v:2,slots:{1:{p,g},2:{p:{},g:{}}}})));
 assert.equal(store.size,0);
`,{risu:true}));
test('save failure reported and queue recovers',async t=>harness(t,setup+`
 const good=Risuai.setArgument; Risuai.setArgument=async()=>{throw new Error('disk full')};
 assert.equal(await saveAll(),false); Risuai.setArgument=good;
 assert.equal(await saveAll(),true); assert.ok(store.has(slotKey(1)));
`,{risu:true}));
test('early combat guard does not consume cooldown outside player turn',async t=>harness(t,setup+`
 player._ultSkill='warrior_ult'; battlePhase='enemyTurn'; currentEnemy={hp:10};
 playerAttack('warrior_ult'); assert.equal(skillCooldowns.warrior_ult,undefined);
 player=null; playerAttack('warrior_ult');
`));
test('victory timer cannot reward a replacement run',async t=>harness(t,setup+`
 currentEnemy={hp:0}; let timers=[]; window.setTimeout=fn=>{timers.push(fn)};
 fxEnemyDeath=showDmgPopup=playVictorySound=function(){};
 let rewards=0; _doVictory=()=>{rewards++};
 handleVictory();handleVictory(); assert.equal(timers.length,1);
 gameState=createGameState(); currentEnemy={hp:0}; timers[0](); assert.equal(rewards,0);
`));
test('codex repeat encounters persist',async t=>harness(t,setup+`
 registerCodex('monsters','slime'); registerCodex('monsters','slime');
 await new Promise(r=>window.setTimeout(r,15));
 assert.equal(JSON.parse(store.get(KEY_CODEX)).monsters.slime.count,2);
`,{risu:true}));
test('UTF-8 transfer roundtrip',async t=>harness(t,`
 const text='기사 ⚔️ 리리스 🦇'; assert.equal(base64ToUtf8(utf8ToBase64(text)),text);
`));
test('UI builds and main menu renders standalone',async t=>harness(t,`
 await initRPG(); assert.ok(document.getElementById(RPG_UI_ID));
 assert.ok(document.body.textContent.includes('0.1')); assert.equal(errors.length,0,errors.join(" | "));
`));
test('all enemy templates scale across six difficulties and ten floors',async t=>harness(t,setup+`
 for(gameDifficulty=1;gameDifficulty<=6;gameDifficulty++) for(let floor=1;floor<=10;floor++) {
  gameState.floor=floor;
  for(const key of Object.keys(ENEMY_TEMPLATES)) {
   const enemy=spawnEnemy(key,floor);
   assert.ok(Number.isFinite(enemy.maxHp) && enemy.maxHp>0,key);
   assert.ok(Number.isFinite(enemy.ac),key+':AC');
  }
 }
`));
test('equipment IDs unique and class start equipment resolve',async t=>harness(t,`
 const ids=new Set(); for(const e of EQUIP_DB) { assert.ok(!ids.has(e.id),e.id); ids.add(e.id); }
 for(const [key,c] of Object.entries(PLAYER_CLASSES)) for(const id of c.startEquip||[]) {
  assert.ok(id==='_random_legendary_' || ids.has(id),key+':'+id);
 }
`));
test('all learned skills can execute a player action without exceptions',async t=>harness(t,setup+`
 window.setTimeout=function(){return 1}; window.setInterval=function(){return 1};
 _fxAttack=false; _fxSkill=false;
 for(const [classKey,c] of Object.entries(PLAYER_CLASSES)) {
  for(const skill of c.skills) {
   gameState=createGameState(); player=createPlayer(classKey); recalcPlayerStats();
   currentEnemy=spawnEnemy('slime',1); currentEnemy.hp=currentEnemy.maxHp=1000000;
   battlePhase='playerTurn'; gameState.phase='battle'; skillCooldowns={};
   playerAttack(skill);
   assert.ok(Number.isFinite(player.hp),classKey+':'+skill);
   assert.ok(Number.isFinite(currentEnemy.hp),classKey+':'+skill);
  }
 }
`));
test('rest context is request-only, character-scoped and retry-safe',async t=>harness(t,setup+`
 let id='owner', handler, removed=false;
 Risuai.getCharacter=async()=>({chaId:id,depth_prompt:{prompt:'keep me'}});
 Risuai.setCharacter=async()=>{throw new Error('must not edit card')};
 Risuai.addRisuReplacer=async(type,fn)=>{handler=fn};
 Risuai.removeRisuReplacer=async()=>{removed=true};
 await startRest(); assert.equal(gameState._resting,true);
 const messages=[{role:'user',content:'hello'}];
 const result=await handler(messages,'model'); assert.equal(result.length,2); assert.equal(messages.length,1);
 assert.equal(result[0].role,'system'); assert.ok(result[0].content.includes('기사')); assert.equal(result[1].content,'hello');
 assert.equal((await handler(result,'model')).length,2);
 assert.equal((await handler(messages,'submodel')).length,1);
 id='different'; assert.equal((await handler(messages,'model')).length,1);
 await resumeExplore(); assert.equal(removed,true); assert.equal(gameState._resting,false);
`,{risu:true}));
test('defeat deletion follows already queued saves',async t=>harness(t,setup+`
 player.hp=0; currentEnemy=spawnEnemy('slime',1); const pending=saveAll();
 playDefeatSound=function(){}; handleDefeat(); await pending;
 await new Promise(r=>window.setTimeout(r,50));
 assert.equal(store.get(slotKey(1)),'');
`,{risu:true}));
test('global graveyard and codex load without a main save',async t=>harness(t,`
 localStorage.setItem(KEY_GRAVEYARD,JSON.stringify([{className:'old hero'}]));
 localStorage.setItem(KEY_CODEX,JSON.stringify({monsters:{slime:{count:5}},equipment:{},skills:{}}));
 await initRPG(); assert.equal(_graveyard[0].className,'old hero'); assert.equal(_codex.monsters.slime.count,5);
`));
test('all skill definitions execute with finite combat state',async t=>harness(t,setup+`
 window.setTimeout=function(){return 1};window.setInterval=function(){return 1}; _fxAttack=false;_fxSkill=false;
 for(const skill of Object.keys(SKILL_DEFS)) {
  gameState=createGameState();player=createPlayer('warrior');recalcPlayerStats();player.skills=[skill];
  currentEnemy=spawnEnemy('slime',1);currentEnemy.hp=currentEnemy.maxHp=1000000;
  battlePhase='playerTurn';gameState.phase='battle';skillCooldowns={};
  playerAttack(skill);
  assert.ok(Number.isFinite(player.hp),skill+':player');assert.ok(Number.isFinite(currentEnemy.hp),skill+':enemy');
 }
`));
test('content registry references resolve',async t=>harness(t,`
 for(const [key,c] of Object.entries(PLAYER_CLASSES)) {
  for(const p of [c.startPassive,c.lv3Passive].filter(Boolean)) assert.ok(PASSIVE_DEFS[p],key+':'+p);
 }
 for(const e of EQUIP_DB) if(e.passive) assert.ok(PASSIVE_DEFS[e.passive],e.id+':'+e.passive);
 for(const [key,e] of Object.entries(ENEMY_TEMPLATES)) for(const sk of e.skills||[]) assert.ok(ENEMY_SKILLS[sk],key+':'+sk);
 assert.ok(Object.keys(PLAYER_CLASSES).length>0);
 report(JSON.stringify({classes:Object.keys(PLAYER_CLASSES).length,skills:Object.keys(SKILL_DEFS).length,passives:Object.keys(PASSIVE_DEFS).length,equipment:EQUIP_DB.length,enemies:Object.keys(ENEMY_TEMPLATES).length}));
`));
test('rest context keeps assistant prefill as the final message',async t=>harness(t,setup+`
 let handler; Risuai.getCharacter=async()=>({chaId:'owner'}); Risuai.addRisuReplacer=async(type,fn)=>{handler=fn};
 await startRest();
 const result=await handler([{role:'system',content:'main'},{role:'user',content:'hi'},{role:'assistant',content:'prefill'}],'model');
 assert.deepEqual(result.map(m=>m.role),['system','system','user','assistant']);
 assert.equal(result[3].content,'prefill');
 const noUser=await handler([{role:'system',content:'main'},{role:'assistant',content:'prefill'}],'model');
 assert.deepEqual(noUser.map(m=>m.role),['system','system','assistant']);
`,{risu:true}));
test('resting save reattaches request context on slot load',async t=>harness(t,setup+`
 let added=0; Risuai.getCharacter=async()=>({chaId:'owner'}); Risuai.addRisuReplacer=async()=>{added++};
 gameState._resting=true; await saveAll(); const raw=store.get(slotKey(1));
 player=null; gameState=null; store.set(slotKey(1),raw);
 await loadFromSlot(1); assert.equal(gameState._resting,true); assert.equal(added,1);
 Risuai.getCharacter=async()=>null; _restRequestHandler=null; gameState._resting=true;
 await restoreRestContext(); assert.equal(gameState._resting,false);
`,{risu:true}));
test('legacy slot missing auxiliary fields still loads',async t=>harness(t,setup+`
 const p=JSON.parse(JSON.stringify(player)), g=JSON.parse(JSON.stringify(gameState));
 delete g.log; delete g.phase; delete p.hp; g.floor='3';
 store.set(slotKey(2),JSON.stringify({player:JSON.stringify(p),gameState:JSON.stringify(g),timestamp:1,summary:''}));
 player=null; gameState=null; await loadFromSlot(2);
 assert.equal(gameState.floor,3); assert.equal(gameState.phase,'chooseDoor'); assert.ok(Array.isArray(gameState.log));
 assert.equal(player.hp,player.maxHp);
`,{risu:true}));
test('unsupported onUnload does not block action button registration',async t=>harness(t,`
 let registered=0;
 Object.assign(Risuai,{onUnload:async()=>{throw new Error('unsupported')},registerButton:async()=>{registered++},
  getRootDocument:async()=>null,resizeContainer:async()=>{},showContainer:async()=>{},hideContainer:async()=>{}});
 await initRPG(); assert.equal(registered,1);
`,{risu:true}));
test('import preview compares slots without writing and restore point undoes overwrite',async t=>harness(t,setup+`
 _graveyard=[{className:'old grave'}]; await saveAll(); const oldRaw=store.get(slotKey(1));
 const p=createPlayer('mage'), g=createGameState(); p.name='<b>x</b>'; g.floor=4;
 const keep={p:JSON.parse(JSON.stringify(player)),g:JSON.parse(JSON.stringify(gameState))};
 player=null; gameState=null; _activeSlot=0;
 const code=utf8ToBase64(JSON.stringify({v:2,slots:{1:{p,g},3:keep},graveyard:[{className:'new grave'}]}));
 const pv=await previewImportCode(code);
 assert.equal(store.get(slotKey(1)),oldRaw); assert.equal(store.has(slotKey(3)),false); assert.equal(store.has(KEY_RESTORE_POINT),false);
 assert.equal(_transferMode,'importPreview'); assert.deepEqual(pv.rows.map(r=>r.slot),[1,3]);
 assert.ok(pv.rows[0].current.summary.includes('Lv.')); assert.equal(pv.rows[1].current,null); assert.deepEqual(pv.globals,['묘지']);
 const html=renderImportPreview(); assert.ok(html.includes('&lt;b&gt;x')); assert.ok(!html.includes('<b>x</b>')); assert.ok(html.includes('4F')); assert.ok(html.includes('rpg_confirmImport'));
 rpg_confirmImport(); await new Promise(r=>window.setTimeout(r,60)); await _saveQueue;
 assert.equal(JSON.parse(JSON.parse(store.get(slotKey(1))).player).classKey,'mage'); assert.equal(_graveyard[0].className,'new grave');
 const rp=JSON.parse(store.get(KEY_RESTORE_POINT)); assert.equal(rp.slots[1],oldRaw); assert.equal(rp.slots[3],null);
 await loadRestorePointInfo(); assert.deepEqual(_restorePointInfo.slots,[1,3]); assert.ok(renderRestorePointPanel().includes('rpg_undoImportAsk'));
 assert.equal(await undoImport(),true);
 assert.equal(store.get(slotKey(1)),oldRaw); assert.equal(store.get(slotKey(3)),''); assert.equal(store.get(KEY_RESTORE_POINT),'');
 assert.equal(_graveyard[0].className,'old grave'); assert.equal(_restorePointInfo,null);
`,{risu:true}));
test('v1 import restore point covers continue save; preview refuses bad code and running game',async t=>harness(t,setup+`
 await saveAll(); const mainBefore=store.get(KEY_PLAYER);
 const p=createPlayer('mage'), g=createGameState();
 assert.equal(await previewImportCode('not base64!!'),null); assert.equal(_importPreview,null);
 gameState.running=true; assert.equal(await previewImportCode(utf8ToBase64(JSON.stringify({p,g}))),null);
 player=null; gameState=null; _activeSlot=0;
 await importSaveCode(utf8ToBase64(JSON.stringify({p,g})));
 assert.equal(JSON.parse(store.get(KEY_PLAYER)).classKey,'mage');
 assert.equal(JSON.parse(store.get(KEY_RESTORE_POINT)).main.player,mainBefore);
 assert.equal(await undoImport(),true); assert.equal(store.get(KEY_PLAYER),mainBefore);
 assert.equal(JSON.parse(JSON.parse(store.get(slotKey(1))).player).classKey,'warrior');
`,{risu:true}));
test('bot character summon reuses ally/boss templates and never edits the card',async t=>harness(t,setup+`
 let cha={chaId:'c1',name:'Aria<img onerror=x>',image:'data:image/png;base64,iVBORw0KGgo='};
 Risuai.getCharacter=async()=>cha; Risuai.setCharacter=async()=>{throw new Error('must not edit card')};
 await refreshBotCharacter(); assert.equal(_botChar.name,'Ariaimg onerror=x'); assert.ok(_botChar.image.startsWith('data:image/png'));
 gameState.doorChoices=generateDoorChoices(); gameState.ally=null;
 assert.ok(renderDoorChoices().includes('rpg_summonBotAlly'));
 assert.equal(summonBotAlly(),true); assert.equal(gameState.ally.id,'bot_guest'); assert.equal(gameState.ally.power,8); assert.equal(gameState.ally.triggerRate,0.25);
 assert.equal(summonBotAlly(),false); assert.ok(!renderDoorChoices().includes('rpg_summonBotAlly'));
 const ref=spawnEnemy(getFloorPool(1).boss,1);
 assert.equal(summonBotBoss(),true); assert.equal(currentEnemy.name,_botChar.name); assert.equal(currentEnemy.maxHp,ref.maxHp);
 assert.equal(currentEnemy.boss,false); assert.equal(gameState.phase,'battle'); assert.equal(summonBotBoss(),false);
 assert.ok(getEnemyPortraitHTML(currentEnemy.key,40).includes('data:image/png'));
 const saved=JSON.parse(JSON.stringify(gameState)); assert.equal(JSON.stringify(saved).includes('iVBORw0KGgo'),false);
 cha={chaId:'c2',name:'Bob',image:'javascript:alert(1)'}; await refreshBotCharacter(); assert.equal(_botChar.image,null);
 cha=null; await refreshBotCharacter(); assert.equal(_botChar,null);
 currentEnemy=null; gameState.phase='chooseDoor'; assert.equal(renderBotSummonPanel(),'');
`,{risu:true}));
test('bot summon hidden in standalone mode',async t=>harness(t,setup+`
 await refreshBotCharacter(); assert.equal(_botChar,null); gameState.doorChoices=generateDoorChoices();
 assert.ok(!renderDoorChoices().includes('rpg_summonBot')); assert.equal(summonBotBoss(),false);
`));
