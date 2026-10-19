// Standalone browser smoke test with API v3-shaped mock, not a stock-host integration test.
const {chromium}=require('playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
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
   await page.waitForFunction(()=>document.querySelector('.rpg-header-title')?.textContent.includes('0.1'));
   await page.evaluate(()=>{rpg_newGame();rpg_selectDifficulty(2);rpg_selectClass('warrior');rpg_confirmGender('female')});
   await page.evaluate(()=>rpg_toggleInventory());
   await page.waitForTimeout(150);
   const state=await page.evaluate(()=>({title:document.querySelector('.rpg-header-title').textContent,inventory:!!document.querySelector('.rpg-inv-cell'),container:document.querySelector('#risu-rpg-container').getBoundingClientRect().toJSON(),text:document.body.textContent.length}));
   assert.ok(state.inventory,JSON.stringify(state)); assert.equal(errors.length,0,errors.join('\n'));
   results.push({viewport,...state,errors}); await page.close();
  }
  console.log(JSON.stringify(results,null,2));
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
