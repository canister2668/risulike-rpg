'use strict';
// 한 런을 끝(사망/클리어/단계 상한)까지 진행하고 측정 기록을 돌려준다.
const {Policy} = require('./policy.cjs');

const MAX_STEPS = 30000;

function ownedSnapshot(sim) {
    const p = sim.g.player;
    const eq = new Set(sim.fn('getAllOwnedEquipment')(p).map(e => e.id));
    const pas = new Set(p.droppablePassives || []);
    return {eq, pas};
}

function stateSig(sim) {
    const gs = sim.g.gameState, p = sim.g.player, e = sim.g.enemy;
    return [gs.phase, gs.currentEvent, sim.g.battlePhase, gs.progress, gs.floor, p.hp, p.gold, p.exp, p.shield,
        e ? e.hp + '/' + (e.shield || 0) : '', gs.chestState, gs.shrineResult, gs.forgeState, gs._dcConfirmIdx, gs._forgeConfirmIdx,
        (gs.merchantOffers || []).filter(o => o.sold).length, (p.skills || []).length, JSON.stringify(sim.g.cooldowns)].join('|');
}

function runGame(sim, {cls, diff, seed, policy, variant}) {
    policy = policy || new Policy();
    sim.reset(seed);
    sim.call('startNewGame');
    sim.call('selectDifficulty', [diff]);
    sim.ev("_selectedGender='female'");
    sim.call('_startGameWithClass', [cls]);
    const o = policy.opts;
    if (o.botAlly || o.botBossFloor) sim.g.botChar = {chaId: 'sim-bot', name: '봇', image: null};
    if (o.roles) { sim.fn('setAllyRole')('lilith', o.roles); sim.fn('setAllyRole')('helena', o.roles); }

    const rec = {cls, diff, seed, variant: variant || 'base', cleared: false, floor: 1, level: 1, death: null,
        battleActions: 0, rooms: 0, steps: 0, stuck: null, encounters: {}, deathsBy: null,
        passives: [], equips: [], skillsUsed: {}, bot: null, ally: null, helena: false, lilith: null, mutations: []};
    const seenEnemies = new WeakSet();
    let owned = ownedSnapshot(sim);
    for (const id of owned.eq) rec.equips.push([id, 0]);
    const bad = new Map(); // 상태 서명 → 효과 없던 행동 키
    let botFight = null;

    while (rec.steps < MAX_STEPS) {
        const gs = sim.g.gameState, p = sim.g.player;
        if (!gs || !p) { rec.stuck = 'no-state'; break; }
        if (!gs.running) break;
        rec.steps++;
        // 전투 외: 포션으로 체력 정비, 봇 소환
        if (gs.phase === 'chooseDoor') {
            let guard = 0;
            while (policy.hpR(p) < o.potionRestHp && guard++ < 6) {
                const pk = policy.usePotion(sim, false);
                if (!pk || sim.fn('usePotionByKey')(pk) <= 0) break;
            }
            if (o.botAlly && !gs.ally && !(gs._botSummon && gs._botSummon.ally) && gs.floor >= 1) sim.fn('summonBotAlly')();
            if (o.botBossFloor && gs.floor >= o.botBossFloor && !(gs._botSummon && gs._botSummon.boss) && policy.hpR(p) >= 0.8) {
                botFight = {floor: gs.floor, hpBefore: p.hp / p.maxHp, exp: p.exp, level: p.level, gold: p.gold, items: owned.eq.size, result: null};
                sim.fn('summonBotBoss')();
                sim.flush();
            }
        }
        // 소프트락: 적 HP 0인데 승리 처리 없이 플레이어 턴(반격 처치 등). 실제 플레이어의 우회책인
        // '이어하기'(rpg_continue: 전투 → 문 선택)와 같은 처리를 하고 횟수를 센다.
        if (gs.phase === 'battle' && sim.g.enemy && sim.g.enemy.hp <= 0 && sim.g.battlePhase === 'playerTurn' && !sim.queue.length) {
            rec.softlocks = (rec.softlocks || 0) + 1;
            rec.softlockAt = rec.softlockAt || [];
            rec.softlockAt.push([sim.g.enemy._botSummon ? 'BOT_BOSS' : sim.g.enemy.key, gs.floor]);
            sim.ev("gameState.phase='chooseDoor'; if(!gameState.doorChoices) gameState.doorChoices=generateDoorChoices(); currentEnemy=null; battlePhase='';");
            continue;
        }
        const e = sim.g.enemy;
        if (e && e.hp > 0 && !seenEnemies.has(e)) {
            seenEnemies.add(e);
            const k = e._botSummon ? 'BOT_BOSS' : e.key;
            rec.encounters[k] = (rec.encounters[k] || 0) + 1;
        }
        let acts = sim.actions().filter(a => !a.disabled || a.name === 'rpg_action');
        const sig = stateSig(sim);
        const badSet = bad.get(sig);
        if (badSet) acts = acts.filter(a => !badSet.has(a.key));
        if (!acts.length) { rec.stuck = 'no-actions:' + gs.phase + '/' + gs.currentEvent + '/' + sim.g.battlePhase; break; }
        let a = policy.choose(sim, acts);
        if (!a) a = acts[0];
        if (a.name === 'rpg_action') {
            rec.battleActions++;
            const sk = a.args[0];
            rec.skillsUsed[sk] = (rec.skillsUsed[sk] || 0) + 1;
        }
        try { sim.call(a.name, a.args); } catch (err) { rec.stuck = 'throw:' + a.key + ':' + err.message; break; }
        if (stateSig(sim) === sig) {
            if (!bad.has(sig)) bad.set(sig, new Set());
            bad.get(sig).add(a.key);
        }
        // 획득 추적
        if (sim.g.player) {
            const now = ownedSnapshot(sim), fl = sim.g.gameState.floor;
            for (const id of now.eq) if (!owned.eq.has(id)) rec.equips.push([id, fl]);
            for (const k of now.pas) if (!owned.pas.has(k)) rec.passives.push([k, fl]);
            owned = now;
        }
        if (!rec.allyJoin && sim.g.gameState.ally) rec.allyJoin = [sim.g.gameState.ally.id, sim.g.gameState.floor];
        if (!rec.helenaJoin && sim.ev('_helenaJoined')) rec.helenaJoin = sim.g.gameState.floor;
        // 봇 보스 결과
        if (botFight && !botFight.result) {
            const en = sim.g.enemy, g2 = sim.g.gameState;
            if (!g2.running) botFight.result = 'death';
            else if (!(en && en._botSummon && en.hp > 0) && g2.phase !== 'battle') {
                const p2 = sim.g.player;
                botFight.result = 'win';
                botFight.expGain = p2.exp - botFight.exp;  // 경험치는 누적형(레벨업 시 차감 없음)
                botFight.goldGain = p2.gold - botFight.gold;
                botFight.itemGain = owned.eq.size - botFight.items;
                botFight.hpAfter = p2.hp / p2.maxHp;
            }
        }
    }
    if (rec.steps >= MAX_STEPS) rec.stuck = 'max-steps';
    const gs = sim.g.gameState, p = sim.g.player;
    rec.cleared = sim.g.battlePhase === 'ending';
    rec.floor = gs ? Math.min(gs.floor, 10) : 0;
    rec.progress = gs ? gs.progress : 0;
    rec.level = p ? p.level : 0;
    rec.rooms = gs ? gs.totalTurns || 0 : 0;
    rec.helena = !!sim.ev('_helenaJoined');
    rec.ally = gs && gs.ally ? gs.ally.id : null;
    rec.lilith = gs && gs.quest && gs.quest.id === 'lilith' ? (gs.quest.flags && gs.quest.flags.ending) || 'active' : null;
    rec.mutations = (sim.ev('_playerMutations') || []).map(m => m.id || m);
    if (p) {
        rec.potionsLeft = Object.values(p.potionInventory || {}).reduce((s, v) => s + (v || 0), 0);
        rec.goldLeft = p.gold; rec.maxHp = p.maxHp; rec.skillCount = (p.skills || []).length;
    }
    if (!rec.cleared && !rec.stuck && sim.g.battlePhase === 'defeat') {
        const en = sim.g.enemy;
        rec.death = en ? (en._botSummon ? 'BOT_BOSS' : en.key) : 'event:' + (gs.currentDoor || gs.currentEvent || '?');
        rec.deathBoss = !!(en && en.boss);
        rec.deathElite = !!(en && en.elite);
    }
    if (botFight) { if (!botFight.result) botFight.result = rec.death === 'BOT_BOSS' ? 'death' : 'win'; rec.bot = botFight; }
    rec.errors = sim.errors.length; sim.errors.length = 0;
    return rec;
}

module.exports = {runGame};
