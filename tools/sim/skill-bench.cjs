#!/usr/bin/env node
'use strict';
// 스킬 91개 효율 벤치마크.
// 조건: 소유 직업(직업 스킬·궁극기) 또는 능력치 기준 대표 직업, Lv.5, 보통 난이도, 5층 라미아(엘리트, 공격 불가).
// 적 HP는 실제 값(최대HP 비례 효과가 현실적으로 나오게)이고, 매 행동 뒤 감소량을 누적한 다음 HP를 되돌린다(처치·승리 처리 없음).
// 1) 1회 사용 피해(적 HP+보호막 감소량, 사용 직후 적 턴의 도트 포함)
// 2) 10턴 로테이션(쿨다운이 돌면 스킬, 아니면 기본 공격) 총 피해 − 기본 공격만 10턴 총 피해 = 추가 피해, /사용 횟수
// 3) 회복·보호막: HP 30%에서 1회 사용 시 HP+보호막 증가량
// 출력: 마크다운 표(stdout), --json 시 JSON.
const {Sim} = require('./engine.cjs');

const TRIALS = +(process.env.BENCH_TRIALS || 300);
const TURNS = 10;
const STAT_CLASS = {STR: 'warrior', DEX: 'rogue', INT: 'mage', WIS: 'cleric', CHA: 'bard', CON: 'warrior'};

function ownerOf(sim, sk) {
    const PC = sim.fn('PLAYER_CLASSES');
    const base = sk.endsWith('_ult') ? sk.slice(0, -4) : sk;
    for (const c in PC) if (PC[c].skills.includes(base)) return {cls: c, src: '직업'};
    const def = sim.fn('SKILL_DEFS')[sk];
    return {cls: STAT_CLASS[def.stat] || 'warrior', src: '획득'};
}

function setup(sim, cls, sk) {
    sim.call('startNewGame');
    sim.call('selectDifficulty', [2]);
    sim.ev(`gameState=createGameState(); player=createPlayer(${JSON.stringify(cls)}); player.exp=_getLevelXP(5); checkLevelUp(); recalcPlayerStats();`);
    const isUlt = sk.endsWith('_ult');
    sim.ev(`player.skills=${JSON.stringify(sk === 'attack' ? [] : [sk])}; player._ultSkill=${isUlt ? JSON.stringify(sk) : 'null'}; skillCooldowns={}; gameState.ally=null;`);
    sim.ev(`currentEnemy=spawnEnemy('eliteLizardman',5); currentEnemy.skills=[]; currentEnemy._skillCooldowns={}; currentEnemy.shield=0; currentEnemy.hitMod=-60; currentEnemy.modifier=null;
        battlePhase='playerTurn'; gameState.phase='battle'; gameState.floor=5;`);
    sim.loss = 0;
}
// 행동 1회: 적 HP 감소량을 누적하고 HP를 되돌린다(최대HP 초과 피해는 잘림).
function act(sim, a, keepHp) {
    const p = sim.g.player, e = sim.g.enemy;
    if (!keepHp) p.hp = p.maxHp; // HP 소모형 스킬도 같은 조건(만피)에서 사용
    if (sim.g.battlePhase !== 'playerTurn') return;
    const before = e.hp + (e.shield || 0);
    sim.call('rpg_action', [a]);
    sim.loss += Math.max(0, before - (e.hp + (e.shield || 0)));
    e.hp = e.maxHp; e.shield = 0;
}
function cdReady(sim, sk) { const c = sim.g.cooldowns[sk]; return !(c > 0); }

function bench(sim, sk) {
    const SK = sim.fn('SKILL_DEFS'), def = SK[sk];
    const {cls, src} = ownerOf(sim, sk);
    let single = 0, rot = 0, base = 0, uses = 0, heal = 0;
    for (let t = 0; t < TRIALS; t++) {
        // 1회 피해
        setup(sim, cls, sk);
        act(sim, sk);
        single += sim.loss;
        // 회복·보호막
        setup(sim, cls, sk);
        const p = sim.g.player; p.hp = Math.max(1, Math.round(p.maxHp * 0.3)); p.shield = 0;
        const h0 = p.hp;
        act(sim, sk, true);
        heal += (sim.g.player.hp - h0) + (sim.g.player.shield || 0);
        // 로테이션
        setup(sim, cls, sk);
        let turns = 0, guard = 0;
        while (turns < TURNS && guard++ < 60) {
            if (sim.g.battlePhase !== 'playerTurn') { sim.flush(); if (sim.g.battlePhase !== 'playerTurn') break; }
            if (cdReady(sim, sk)) {
                uses++;
                act(sim, sk);
                if (!def.freeTurn) turns++;
            } else { act(sim, 'attack'); turns++; }
        }
        rot += sim.loss;
        // 기본 공격만
        setup(sim, cls, 'attack');
        for (let i = 0; i < TURNS; i++) { if (sim.g.battlePhase !== 'playerTurn') break; act(sim, 'attack'); }
        base += sim.loss;
    }
    return {sk, name: def.name, cls, src, cd: def.cooldown || 0, free: !!def.freeTurn, rarity: def.rarity || (src === '직업' ? 'class' : ''),
        single: single / TRIALS, rot: rot / TRIALS, base: base / TRIALS, uses: uses / TRIALS, heal: heal / TRIALS,
        gainPerUse: uses ? (rot - base) / uses : 0, gainPerTurn: (rot - base) / TRIALS / TURNS};
}

if (require.main === module) {
    const sim = new Sim();
    sim.reset(12345);
    const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const keys = only.length ? only : Object.keys(sim.fn('SKILL_DEFS'));
    const rows = [];
    for (const sk of keys) {
        sim.reset(0xBEEF ^ keys.indexOf(sk));
        sim.ev('handleVictory=function(){}; _doVictory=function(){};');
        try { rows.push(bench(sim, sk)); } catch (e) { rows.push({sk, error: e.message}); }
        if (sim.errors.length) { rows[rows.length - 1].errors = sim.errors.slice(0, 3); sim.errors.length = 0; }
    }
    if (process.argv.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); return; }
    console.log(`조건: Lv.5, 보통, 5층 라미아(엘리트·무공격, 실제 HP, 매 행동 후 복구), 시도 ${TRIALS}회, 로테이션 ${TURNS}턴. 피해는 평균값.`);
    console.log('');
    console.log('| 스킬 | 직업/출처 | 쿨 | 턴소모 | 1회 피해 | 10턴 추가 피해 | 사용당 추가 피해 | 턴당 추가 피해 | 회복+보호막(1회) |');
    console.log('|---|---|---:|---|---:|---:|---:|---:|---:|');
    for (const r of rows.sort((a, b) => (b.gainPerTurn || 0) - (a.gainPerTurn || 0))) {
        if (r.error) { console.log(`| ${r.sk} | 오류 ${r.error} | | | | | | | |`); continue; }
        console.log(`| ${r.name} (\`${r.sk}\`) | ${r.cls}/${r.src}${r.rarity && r.rarity !== 'class' ? ' ' + r.rarity : ''} | ${r.cd} | ${r.free ? '없음' : '소모'} | ${r.single.toFixed(1)} | ${(r.rot - r.base).toFixed(1)} | ${r.gainPerUse.toFixed(1)} | ${r.gainPerTurn.toFixed(2)} | ${r.heal.toFixed(1)} |`);
    }
}

module.exports = {bench};
