// Standalone browser smoke test with API v3-shaped mock, not a stock-host integration test.
const {chromium}=require('playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
// v0.2 feature screens: internals are reached through an eval hook injected in place of the init call,
// so real Chromium canvas/DOM APIs are exercised. Set SCREENSHOT_DIR to keep PNGs.
async function featureScreens(browser) {
 const page=await browser.newPage({viewport:{width:390,height:844}}); const errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.route('https://risulike.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
 await page.goto('https://risulike.test/');
 await page.evaluate(()=>{
  const args={}; window.__replacers=[]; window.__cardWrites=0;
  window.Risuai={
   safeLocalStorage:{getItem:async k=>localStorage.getItem(k),setItem:async(k,v)=>localStorage.setItem(k,v)},
   getArgument:async k=>args[k],setArgument:async(k,v)=>{args[k]=v},
   registerButton:async()=>1,getRootDocument:async()=>null,resizeContainer:async()=>undefined,
   showContainer:async()=>{},hideContainer:async()=>{},onUnload:async()=>{},
   getCharacter:async()=>({chaId:'c1',name:'테스트 봇',image:null}),
   setCharacter:async()=>{window.__cardWrites++},
   addRisuReplacer:async(t,fn)=>{window.__replacers.push(fn)},removeRisuReplacer:async(t,fn)=>{window.__replacers=window.__replacers.filter(f=>f!==fn)}
  };
 });
 const src=fs.readFileSync('Risulike RPG.js','utf8').replace('await initRPG();','window.__rpg=function(code){return eval(code)}; await initRPG();');
 await page.addScriptTag({content:src});
 await page.waitForFunction(()=>typeof window.__rpg==='function' && document.querySelector('#rpg-menu-volume'));
 const shot=async name=>{ if(process.env.SCREENSHOT_DIR) await page.screenshot({path:require('node:path').join(process.env.SCREENSHOT_DIR,name+'.png')}); };
 const out={feature:true};
 await shot('01-main-menu-settings');
 out.preview=await page.evaluate(async()=>window.__rpg(`(async()=>{
  gameDifficulty=2; gameState=createGameState(); player=createPlayer('warrior'); _activeSlot=1; await saveAll();
  var code=utf8ToBase64(JSON.stringify({v:2,slots:{1:{p:createPlayer('mage'),g:createGameState()},2:{p:createPlayer('rogue'),g:createGameState()}}}));
  player=null; gameState=null; _activeSlot=0; render();
  await previewImportCode(code); return document.body.textContent.includes('가져오기 미리보기');
 })()`));
 await shot('02-import-preview');
 out.undo=await page.evaluate(async()=>window.__rpg(`(async()=>{
  window.rpg_confirmImport(); await new Promise(r=>setTimeout(r,200)); await _saveQueue;
  await window.rpg_openSlotMenu(); return !!document.querySelector('[data-action="rpg_undoImportAsk"]');
 })()`));
 await shot('03-slot-menu-undo');
 out.door=await page.evaluate(async()=>window.__rpg(`(async()=>{
  _slotMenuOpen=false; gameState=createGameState(); player=createPlayer('warrior'); recalcPlayerStats(); _activeSlot=4;
  gameState.ally=null; gameState.doorChoices=generateDoorChoices(); _helenaJoined=true; await refreshBotCharacter(); render();
  return {summon:!!document.querySelector('[data-action="rpg_summonBotAlly"]'),roles:!!document.querySelector('[data-action="rpg_setAllyRole"]')};
 })()`));
 await shot('04-door-summon-roles');
 out.card=await page.evaluate(async()=>window.__rpg(`(async()=>{
  _helenaJoined=false; gameState.floor=3; player.killCount=11; _lastHitInfo={enemyName:'골렘',enemyIcon:'🗿',skillName:'분쇄',damage:40};
  playDefeatSound=function(){}; player.hp=0; currentEnemy=spawnEnemy('golem',3); handleDefeat(); await _saveQueue;
  await window.rpg_makeRunCard(); var url=_runShare&&_runShare.dataUrl;
  var img=new Image(); await new Promise(r=>{img.onload=r;img.onerror=r;img.src=url;});
  return {png:!!url&&url.startsWith('data:image/png;base64,'),bytes:url?Math.round(url.length*0.75):0,w:img.naturalWidth,h:img.naturalHeight};
 })()`));
 await page.evaluate(()=>{const b=document.querySelector('.rpg-body'); const img=b&&b.querySelector('img[alt="런 결과 카드"]'); if(img) img.scrollIntoView();});
 await shot('05-result-card');
 if(process.env.SCREENSHOT_DIR) await page.evaluate(()=>window.__rpg('_runShare.dataUrl')).then(u=>fs.writeFileSync(require('node:path').join(process.env.SCREENSHOT_DIR,'06-card.png'),Buffer.from(u.split(',')[1],'base64')));
 out.attach=await page.evaluate(async()=>window.__rpg(`(async()=>{
  await window.rpg_attachRunSummary(); var h=window.__replacers[0];
  var r1=await h([{role:'user',content:'hi'}],'model'); await new Promise(r=>setTimeout(r,20));
  return {inserted:r1.length===2&&r1[0].content.includes('골렘'),released:window.__replacers.length===0,cardWrites:window.__cardWrites};
 })()`));
 out.fxOff=await page.evaluate(async()=>window.__rpg(`(async()=>{ setFxLevel('off'); setSfxVolume(30); player=null; gameState=null; battlePhase=''; render();
  return getComputedStyle(document.querySelector('#rpg-menu-volume')).transitionDuration; })()`));
 out.errors=errors;
 assert.ok(out.preview&&out.undo&&out.door.summon&&out.door.roles,JSON.stringify(out));
 assert.ok(out.card.png&&out.card.w===540&&out.card.h===720,JSON.stringify(out.card));
 assert.ok(out.attach.inserted&&out.attach.released&&out.attach.cardWrites===0,JSON.stringify(out.attach));
 assert.equal(errors.length,0,errors.join('\n'));
 await page.close(); return out;
}
(async()=>{
 const browser=await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH || undefined});
 try {
  const results=[];
  for(const viewport of [{width:1280,height:800},{width:390,height:844}]) {
   const page=await browser.newPage({viewport}); const errors=[];
   page.on('pageerror',e=>errors.push(String(e)));
   page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
   await page.route('https://risulike.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
   await page.goto('https://risulike.test/');
   await page.evaluate(()=>{
    const args={}; window.Risuai={
     safeLocalStorage:{getItem:async k=>localStorage.getItem(k),setItem:async(k,v)=>localStorage.setItem(k,v)},
     getArgument:async k=>args[k],setArgument:async(k,v)=>{args[k]=v},
     registerButton:async()=>1,getRootDocument:async()=>null,
     resizeContainer:async()=>undefined,showContainer:async()=>{},hideContainer:async()=>{},onUnload:async()=>{}
    };
   });
   await page.addScriptTag({content:fs.readFileSync('Risulike RPG.js','utf8')});
   await page.waitForFunction(()=>document.querySelector('.rpg-header-title')?.textContent.includes('0.2'));
   await page.evaluate(()=>{rpg_newGame();rpg_selectDifficulty(2);rpg_selectClass('warrior');rpg_confirmGender('female')});
   await page.evaluate(()=>rpg_toggleInventory());
   await page.waitForTimeout(150);
   const state=await page.evaluate(()=>({title:document.querySelector('.rpg-header-title').textContent,inventory:!!document.querySelector('.rpg-inv-cell'),container:document.querySelector('#risu-rpg-container').getBoundingClientRect().toJSON(),text:document.body.textContent.length}));
   assert.ok(state.inventory,JSON.stringify(state)); assert.equal(errors.length,0,errors.join('\n'));
   results.push({viewport,...state,errors}); await page.close();
  }
  results.push(await featureScreens(browser));
  console.log(JSON.stringify(results,null,2));
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
