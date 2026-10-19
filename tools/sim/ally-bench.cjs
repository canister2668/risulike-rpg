#!/usr/bin/env node
'use strict';
// 동료(봇 동료·리리스 결혼 동료·헬레나) 역할별 전투 단위 비교.
// 같은 시드 목록으로 층 보스전을 반복하고 승률·남은 HP·전투 턴을 비교한다(정책 AI의 전투 규칙 사용).
// 예) node tools/sim/ally-bench.cjs --fights 400
const {Sim} = require('./engine.cjs');
const {Policy} = require('./policy.cjs');

// 시나리오: 직업·층·난이도. 레벨은 '동료 없음' 승률이 50%에 가장 가깝도록 자동 보정한다(calibrate).
const SCEN = [
    {cls: 'warrior', floor: 2, diff: 2}, {cls: 'mage', floor: 2, diff: 2},
    {cls: 'cleric', floor: 4, diff: 2}, {cls: 'rogue', floor: 4, diff: 2},
    {cls: 'bard', floor: 6, diff: 2}, {cls: 'necro', floor: 6, diff: 2},
    {cls: 'paladin', floor: 3, diff: 3}, {cls: 'hunter', floor: 3, diff: 3},
];
const LILITH_MARRIED = `{ id:"lilith", name:"리리스", icon:"🦇", triggerRate:0.30, effect:"damage", power:10, dialogue:["a"] }`;
const BOT_ALLY = `{ id:"bot_guest", name:"봇", icon:"🤝", triggerRate:0.25, effect:"damage", power:8, dialogue:["a"] }`;
const ARMS = [
    {name: '동료 없음'},
    {name: '봇 동료(25%·8%)', ally: BOT_ALLY},
    {name: '리리스(결혼)·기본', ally: LILITH_MARRIED, married: true, lilith: 'balanced'},
    {name: '리리스(결혼)·공격', ally: LILITH_MARRIED, married: true, lilith: 'attack'},
    {name: '리리스(결혼)·보호', ally: LILITH_MARRIED, married: true, lilith: 'guard'},
    {name: '리리스(결혼)·탐색', ally: LILITH_MARRIED, married: true, lilith: 'scout'},
    {name: '헬레나·기본', helena: 'balanced'},
    {name: '헬레나·공격', helena: 'attack'},
    {name: '헬레나·보호', helena: 'guard'},
    {name: '헬레나·탐색', helena: 'scout'},
];

function fight(sim, policy, sc, arm, seed) {
    sim.reset(seed);
    sim.call('startNewGame'); sim.call('selectDifficulty', [sc.diff]);
    sim.ev(`gameState=createGameState(); player=createPlayer(${JSON.stringify(sc.cls)}); player.exp=_getLevelXP(${sc.level}); checkLevelUp(); recalcPlayerStats(); player.hp=player.maxHp;
        gameState.floor=${sc.floor}; gameState.progress=10; gameState.totalTurns=${sc.floor * 9}; skillCooldowns={};`);
    sim.ev(`gameState.ally=${arm.ally || 'null'}; gameState.allyRoles={lilith:${JSON.stringify(arm.lilith || 'balanced')}, helena:${JSON.stringify(arm.helena || 'balanced')}};
        _helenaJoined=${arm.helena ? 'true' : 'false'}; _helenaReviveUsed=true; // 사망 구출(런당 1회)은 역할과 무관하므로 끈다`);
    if (arm.married) sim.ev(`gameState.quest={id:"lilith",stage:9,active:false,choices:{kindness:2},flags:{ending:"marry"}};`);
    sim.call('startBossBattle');
    let turns = 0, guard = 0;
    while (guard++ < 400) {
        const gs = sim.g.gameState;
        if (!gs.running) return {win: false, turns, hp: 0, helenaSave: !sim.ev('_helenaReviveUsed') ? 0 : (arm.helena ? 1 : 0)};
        const e = sim.g.enemy;
        if (gs.phase !== 'battle' || !e || e.hp <= 0) {
            if (e && e.hp <= 0 && sim.g.battlePhase === 'playerTurn' && !sim.queue.length) break; // 소프트락 = 처치로 간주
            if (gs.phase !== 'battle' || sim.g.battlePhase === 'victory' || !e) break;
        }
        const acts = sim.actions().filter(a => a.name === 'rpg_action');
        if (!acts.length) { sim.flush(); if (!sim.actions().some(a => a.name === 'rpg_action')) break; continue; }
        const a = policy.battle(sim, acts);
        if (!a || a.name !== 'rpg_action') break;
        if (!(sim.fn('SKILL_DEFS')[a.args[0]] || {}).freeTurn && !String(a.args[0]).startsWith('potion_')) turns++;
        sim.call(a.name, a.args);
    }
    const p = sim.g.player;
    return {win: true, turns, hp: p.hp / p.maxHp, helenaSave: arm.helena && sim.ev('_helenaReviveUsed') ? 1 : 0};
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    const fights = +(argv[argv.indexOf('--fights') + 1] || 300);
    const sim = new Sim();
    const policy = new Policy();
    const res = ARMS.map(a => ({name: a.name, perScen: []}));
    for (const sc of SCEN) {
        // 레벨 보정
        let bestL = sc.floor + 1, bestD = 9;
        for (let L = Math.max(1, sc.floor - 2); L <= sc.floor + 8; L++) {
            let w = 0; const n = 40;
            for (let i = 0; i < n; i++) if (fight(sim, policy, Object.assign({}, sc, {level: L}), ARMS[0], 0xCA1 + i * 104729).win) w++;
            const d = Math.abs(w / n - 0.5);
            if (d < bestD) { bestD = d; bestL = L; }
            if (w / n > 0.5) break;
        }
        sc.level = bestL;
        ARMS.forEach((arm, ai) => {
            let w = 0, hp = 0, t = 0, saves = 0;
            for (let i = 0; i < fights; i++) {
                const r = fight(sim, policy, sc, arm, 0xA11 + i * 7919 + sc.floor * 31);
                if (r.win) { w++; hp += r.hp; t += r.turns; }
                saves += r.helenaSave;
            }
            res[ai].perScen.push({win: w / fights, hp: w ? hp / w : 0, turns: w ? t / w : 0, saves: saves / fights});
        });
    }
    if (argv.includes('--json')) { console.log(JSON.stringify({SCEN, res}, null, 1)); return; }
    console.log(`보스전 ${fights}회 × 시나리오 ${SCEN.length}개(같은 시드). 칸: 승률% / 승리 시 남은 HP% / 승리까지 턴`);
    console.log('');
    console.log('| 동료 | ' + SCEN.map(s => `${s.cls} ${s.floor}F Lv${s.level} 난이도${s.diff}`).join(' | ') + ' | 평균 승률 |');
    console.log('|---|' + SCEN.map(() => '---').join('|') + '|---:|');
    for (const r of res) {
        const avg = r.perScen.reduce((s, x) => s + x.win, 0) / r.perScen.length;
        console.log(`| ${r.name} | ` + r.perScen.map(x => `${(100 * x.win).toFixed(0)} / ${(100 * x.hp).toFixed(0)} / ${x.turns.toFixed(1)}`).join(' | ') + ` | ${(100 * avg).toFixed(1)} |`);
    }
}
module.exports = {fight, SCEN, ARMS};
