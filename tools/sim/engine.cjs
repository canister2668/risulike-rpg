'use strict';
// Risulike RPG 헤드리스 시뮬레이터 엔진.
// - 실제 게임 파일을 jsdom 창에서 평가하고(테스트 하네스와 같은 `await initRPG();` 치환),
//   화면 렌더 대신 현재 단계의 렌더 함수가 만든 HTML에서 data-action 버튼만 읽어 정책이 고른다.
// - setTimeout 은 가상 시계 큐로 대체해 즉시 순서대로 실행한다(적 턴·승리 처리 등이 타이머에 걸려 있음).
// - Math.random 은 시드 고정 PRNG(mulberry32)로 대체한다. 런마다 소스를 다시 평가해 전역 상태를 초기화한다.
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');

function loadSource(file) {
    const src = fs.readFileSync(file || process.env.RPG_SOURCE || path.join(ROOT, 'Risulike RPG.js'), 'utf8');
    // 내장 이미지는 게임 로직과 무관하므로 짧은 자리표시로 바꿔 렌더 문자열 비용을 줄인다.
    return src.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{100,}/g, 'data:image/png;base64,AA');
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 게임 소스 안(같은 eval 스코프)에서 실행되는 코드: 연출·저장·사운드를 끄고 내부 함수를 노출한다.
const HOOK = `
globalThis.__rpg = {
  get player(){return player}, get gameState(){return gameState}, get enemy(){return currentEnemy},
  get battlePhase(){return battlePhase}, get cooldowns(){return skillCooldowns}, get playerBuff(){return playerBuff},
  get difficulty(){return gameDifficulty}, get lastHit(){return _lastHitInfo}, get helenaJoined(){return _helenaJoined},
  get botChar(){return _botChar}, set botChar(v){_botChar=v},
  get goldenChoices(){return _goldenRewardChoices},
  setDifficulty(v){gameDifficulty=v},
  ev:function(__s){ return eval(__s); }
};
(function(){
  var noop=function(){};
  render=noop; showToast=noop; showDmgPopup=noop; showAllyPopupOverlay=noop; showHelenaPopup=noop;
  _triggerFx=noop; fxUltimate=noop; fxSkill=noop; fxDebuff=noop; fxBuff=noop; syncRpgContainerSize=noop;
  playTone=noop; _playNoise=noop; _playSweep=noop; _playLayered=noop; _playVoice=noop; _playShout=noop;
  playAttackSound=playHitSound=playCritSound=playMissSound=playLevelUpSound=playVictorySound=playDefeatSound=noop;
  playPotionSound=playGoldSound=playDangerSound=playBlessSound=noop;
  fxEnemyHit=fxEnemyCrit=fxEnemyHitElement=fxEnemyCritElement=fxEnemyMiss=fxEnemyDeath=noop;
  fxEnemyAttack=fxEnemyAttackCrit=fxEnemyAttackSkill=fxEnemyAttackMiss=fxPlayerHit=fxPlayerCrit=fxPlayerHeal=fxPlayerBuff=fxPlayerShield=noop;
  var ok=function(){return Promise.resolve(true)};
  saveAll=ok; slotSaveAll=ok; saveCodex=ok; saveGraveyard=ok; saveAchievements=ok; saveStarShop=ok; saveHallOfFameChar=ok;
  deleteSlot=ok; writeSaveValue=ok; registerCodex=noop; refreshBotCharacter=ok;
  if (globalThis.__simQuietLog) { addLog=noop; }
  _activeSlot=1; _autoFreeTurn=false; _fxAttack=false; _fxSkill=false; _fxEquip=false; _fxRoom=false;
  _starShop=_defaultStarShop();
  // 속도: 장비 정의 선형 탐색을 Map 조회로 바꾼다(EQUIP_DB id는 유일, 결과 동일).
  var __eqMap=new Map(); for (var __i=0;__i<EQUIP_DB.length;__i++) if(!__eqMap.has(EQUIP_DB[__i].id)) __eqMap.set(EQUIP_DB[__i].id,EQUIP_DB[__i]);
  findEquipDefById=function(id){ if(!id) return null; var d=__eqMap.get(id); return d||null; };
  // 속도: ensurePlayerSlotData 는 같은 장비 구성이면 결과가 같으므로(난수 미사용) 구성이 그대로일 때 건너뛴다.
  var __ensure=ensurePlayerSlotData, __eP=null, __eInv=[], __eGrow=[], __eEq=[], __eLeg=[];
  var __EQK=['weapon1','weapon2','body','head','boots','accessory1','accessory2','relic'];
  ensurePlayerSlotData=function(p){
    if(!p || !Array.isArray(p.inventory) || !p.equipped || Array.isArray(p.equipped) || !Array.isArray(p.activeLegendSlots)) { __eP=null; return __ensure(p); }
    var same = p===__eP && p.inventory.length===__eInv.length && p.activeLegendSlots.length===__eLeg.length && Object.keys(p.equipped).length===__EQK.length;
    for(var i=0; same && i<p.inventory.length; i++){ var it=p.inventory[i]; if(it!==__eInv[i] || (it&&it._growthBonus)!==__eGrow[i]) same=false; }
    for(var j=0; same && j<__EQK.length; j++){ if(p.equipped[__EQK[j]]!==__eEq[j]) same=false; }
    for(var l=0; same && l<__eLeg.length; l++){ if(p.activeLegendSlots[l]!==__eLeg[l]) same=false; }
    if(same) return;
    __ensure(p); __eP=p;
    __eInv=p.inventory.slice(); __eGrow=__eInv.map(function(it){return it&&it._growthBonus;});
    __eEq=__EQK.map(function(k){return p.equipped[k];}); __eLeg=p.activeLegendSlots.slice();
  };
})();
`;

const UI_ONLY = /^rpg_(toggle|close|codex|select(Inv|Legend)|lock|axis|expand|collapse|clearLegend|legend(Toggle|Unequip|Auto)|disassemble|bulk|rest$|resumeExplore|viewJourney|makeRunCard|downloadRunCard|copy|attach|cancelJourney|summonBot|setAllyRole|newGame|confirmNewGame|cancelNewGame|exportCode|importCode|doImport|confirmImport|undo|overwriteSlot|loadSlot|hall|buyStar|refund|cycleFx|usePotionAnytime|sellItem|xxx)/;

class Sim {
    constructor(source) {
        this.source = source || loadSource();
        this.code = this.source.replace('await initRPG();', HOOK);
        if (this.code === this.source) throw new Error('initRPG hook not found');
        this.dom = new JSDOM('<!doctype html><body></body>', {url: 'https://sim.invalid', runScripts: 'outside-only'});
        this.w = this.dom.window;
        const errors = this.errors = [];
        this.w.console = {log() {}, warn() {}, info() {}, error(...a) { errors.push(a.map(String).join(' ').slice(0, 300)); }};
        this.w.__simQuietLog = true;
        this._installTimers();
    }
    _installTimers() {
        const sim = this;
        this.queue = []; this.now = 0; this.seq = 0;
        this.w.setTimeout = function(fn, ms) {
            if (typeof fn !== 'function') return 0;
            const id = ++sim.seq;
            sim.queue.push({t: sim.now + (+ms || 0), id, fn});
            return id;
        };
        this.w.clearTimeout = function(id) { sim.queue = sim.queue.filter(x => x.id !== id); };
        this.w.setInterval = function() { return ++sim.seq; };
        this.w.clearInterval = function() {};
        this.w.requestAnimationFrame = function() { return 0; };
    }
    reset(seed) {
        this.queue = []; this.now = 0;
        this.rng = mulberry32(seed);
        this.w.Math.random = this.rng;
        this.w.eval(this.code);
        this.g = this.w.__rpg;
        this._fnCache = Object.create(null);
    }
    // 게임 클로저 내부 함수/변수 참조 (direct eval)
    // 함수와 재할당되지 않는 데이터 표만 캐시한다(그 외 변수는 ev/val로 매번 읽기).
    fn(name) {
        let f = this._fnCache[name];
        if (!f) {
            f = this.g.ev(name);
            if (typeof f === 'function' || /^[A-Z][A-Z_]+$/.test(name)) this._fnCache[name] = f;
        }
        return f;
    }
    ev(code) { return this.g.ev(code); }
    flush(limit = 20000) {
        let n = 0;
        while (this.queue.length) {
            let bi = 0;
            for (let i = 1; i < this.queue.length; i++) {
                const a = this.queue[i], b = this.queue[bi];
                if (a.t < b.t || (a.t === b.t && a.id < b.id)) bi = i;
            }
            const job = this.queue.splice(bi, 1)[0];
            this.now = Math.max(this.now, job.t);
            try { job.fn(); } catch (e) { this.errors.push('timer: ' + (e && e.message)); }
            if (++n > limit) throw new Error('timer flush limit');
        }
    }
    call(name, args) {
        const fn = this.w[name] || this.fn(name);
        if (typeof fn !== 'function') throw new Error('no handler ' + name);
        const r = fn.apply(null, args || []);
        this.flush();
        return r;
    }
    // 현재 화면(render()의 단계 분기와 동일)의 HTML
    screenHtml() {
        const gs = this.g.gameState, f = n => this.fn(n)();
        if (!gs) return '';
        if (gs._legendaryChoicePending && gs._legendaryChoice) {
            return gs._legendaryChoice.map(id => `<button data-action="rpg_pickLegendary" data-args="${id}">`).join('');
        }
        switch (gs.phase) {
            case 'mutation': return f('renderMutationChoice');
            case 'chooseDoor': return f('renderDoorChoices');
            case 'battle': return f('renderBattleArea');
            case 'event': return f('renderEventArea');
            case 'bossCleared': case 'dragonCleared': return f('renderBossCleared');
            default: return '';
        }
    }
    actions() {
        const html = this.screenHtml();
        const out = [];
        const re = /<[a-zA-Z]+\b[^>]*?data-action="([A-Za-z_0-9]+)"[^>]*>/g;
        let m;
        while ((m = re.exec(html))) {
            const tag = m[0], name = m[1];
            if (UI_ONLY.test(name)) continue;
            const am = /data-args="([^"]*)"/.exec(tag);
            const disabled = /\sdisabled(?=[\s=>/])/.test(tag) || /cursor:not-allowed/.test(tag);
            const args = am ? this.fn('_parseSimpleArgs')(am[1]) : [];
            out.push({name, args, disabled, key: name + '(' + args.join(',') + ')'});
        }
        // 중복 제거
        const seen = new Set();
        return out.filter(a => !seen.has(a.key) && seen.add(a.key));
    }
}

module.exports = {Sim, loadSource, mulberry32, ROOT};
