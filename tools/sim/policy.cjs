'use strict';
// 단순하지만 합리적인 자동 플레이 정책.
// 원칙: 쿨다운이 돈 스킬 우선, HP가 낮으면 회복 스킬/포션, 문은 위험도 점수, 상점·장비는 희귀도 점수.
// 실제 플레이어(판단·학습·메타 진행)와 다르다는 점은 docs/BALANCE.md 한계 절에 적는다.

const RARITY_SCORE = {common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 6, mythic: 8};

// 문: [보상, 위험]. 점수 = 보상 - 위험 × 위험가중(HP가 낮을수록 커짐)
const DOOR_SCORE = {
    barrier: [2, 0], library: [3, 0.2], treasure: [3.5, 0.6], forge_room: [2.5, 0],
    celestial_forge: [4, 0], legend_altar: [6, 0], gambling: [0.8, 0.2], door: [1, 1],
    wide: [1, 0.9], maze: [0.6, 0.8], mirror: [1.6, 1.6], trial: [2.4, 2.2], dark: [0.8, 1.6],
    poison: [0.8, 1.6], narrow: [0.9, 1.4], magi: [1, 2], timewarp: [0.8, 2.4], cursed: [1.5, 0.8],
    dragon_nest: [4, 4.5], quest_lilith: [5, 0.3],
};

const MUTATION_PREF = ['ironSkin', 'regenerator', 'focused', 'vampiric', 'cursedPower', 'berserking', 'scholar', 'thorns', 'nimbleBody', 'glasscannon'];
const QUEST_PREF = ['dg_help', 'dg_marry', 'dg_protect', 'dg_share', 'ws_accept', 'ws_free', 'at_accept', 'av_accept', 'sm_decline', 'sm_stop'];
const POTION_ORDER = ['potion_s', 'potion_m', 'potion_l', 'potion_x', 'potion_full'];
const POTION_AVG = {potion_s: 7, potion_m: 13.5, potion_l: 23, potion_x: 43, potion_full: 99999};

function diceAvg(str) {
    // "2d10", "1d6×3", "3d6×5", "2d6/4d8"(앞 값), "1~6d12"(3.5d12)
    if (!str || str === '—') return 0;
    let mult = 1;
    const mm = /[×x](\d+)/.exec(str); if (mm) mult = +mm[1];
    const r = /(\d+)(?:~(\d+))?d(\d+)/.exec(str);
    if (!r) return 0;
    const n = r[2] ? (+r[1] + +r[2]) / 2 : +r[1];
    return {avg: n * (+r[3] + 1) / 2, mult};
}

class Policy {
    constructor(opts = {}) {
        this.opts = Object.assign({
            potionBattleHp: 0.35, potionRestHp: 0.45, healSkillHp: 0.6,
            dragonNest: 'strong', botAlly: false, botBossFloor: 0, roles: null,
        }, opts);
    }
    hpR(p) { return p.hp / Math.max(1, p.maxHp); }
    ability(sim, stat) {
        const p = sim.g.player;
        const eff = sim.fn('getEffectiveAbilities')();
        const map = {STR: 'str', DEX: 'dex', CON: 'con', INT: 'int', WIS: 'wis', CHA: 'cha'};
        const k = map[stat] || p.attackAbility;
        return Math.floor((eff[k] - 10) / 2);
    }
    skillValue(sim, sk) {
        const def = sim.fn('SKILL_DEFS')[sk];
        if (!def) return 0;
        if (sk.endsWith('_ult')) return 1000;
        const enemy = sim.g.enemy;
        if (sk === 'divineJudge') return enemy ? enemy.hp * 0.25 : 30;
        if (sk === 'lifeGamble') return sim.g.player.maxHp * 0.7;
        if (sk === 'executeBlow') return 25;
        if (sk === 'randomCast' || sk === 'wildSurge') return 20;
        const d = diceAvg(def.dice);
        if (!d) return 0;
        return (d.avg + Math.max(0, this.ability(sim, def.stat))) * d.mult;
    }
    usePotion(sim, inBattle) {
        const p = sim.g.player, inv = p.potionInventory || {};
        const missing = p.maxHp - p.hp;
        const owned = POTION_ORDER.filter(k => inv[k] > 0);
        if (!owned.length) return null;
        const enough = owned.find(k => POTION_AVG[k] * (k === 'potion_full' ? 1 : 1) >= missing * 0.5);
        return enough || owned[owned.length - 1];
    }

    // ── 화면별 선택 ──
    choose(sim, acts) {
        const gs = sim.g.gameState, p = sim.g.player;
        const by = name => acts.filter(a => a.name === name);
        const first = name => by(name)[0];
        const any = (...names) => { for (const n of names) { const a = first(n); if (a) return a; } return null; };
        if (gs._legendaryChoicePending) return this.pickLegendaryStart(sim, by('rpg_pickLegendary')) || acts[0];
        switch (gs.phase) {
            case 'battle': return this.battle(sim, acts) ;
            case 'chooseDoor': return this.door(sim, by('rpg_enterDoor'));
            case 'mutation': return this.mutation(sim, acts);
            case 'bossCleared': case 'dragonCleared':
                return any('rpg_finishDungeon', 'rpg_nextFloor', 'rpg_proceed') || acts[0];
        }
        // event
        const ev = gs.currentEvent || '';
        if (ev.indexOf('quest_') === 0 || by('rpg_questChoice').length) {
            for (const c of QUEST_PREF) {
                const a = acts.find(x => x.name === 'rpg_questChoice' && x.args[0] === c);
                if (a) {
                    if ((c === 'dg_protect') && this.hpR(p) < 0.6) continue;
                    return a;
                }
            }
            return any('rpg_questProceed', 'rpg_proceed') || acts.find(x => x.name === 'rpg_questChoice') || acts[0];
        }
        if (first('rpg_helenaAccept')) return first('rpg_helenaAccept');
        if (by('rpg_pickGoldenReward').length) return this.golden(sim, by('rpg_pickGoldenReward'));
        if (by('rpg_legendaryBless').length) return this.legendAltar(sim, by('rpg_legendaryBless'));
        if (first('rpg_inspectChest')) return first('rpg_inspectChest');
        if (first('rpg_disarmChest') || first('rpg_openChest')) {
            if (gs.chestPeeked === 'mimic' && this.hpR(p) < 0.5) return first('rpg_skipChest');
            return any('rpg_disarmChest', 'rpg_openChest');
        }
        if (first('rpg_shrineYes')) {
            const wis = this.ability(sim, 'WIS');
            const pSucc = Math.min(1, Math.max(0, (21 - (10 + gs.floor - wis)) / 20));
            return pSucc >= 0.5 ? first('rpg_shrineYes') : first('rpg_shrineNo');
        }
        if (by('rpg_pickPassive').length) return this.pickPassive(sim, by('rpg_pickPassive'));
        if (by('rpg_pickBlessing').length) return this.pickSkill(sim, by('rpg_pickBlessing'));
        if (by('rpg_pickBlessingReward').length) return this.blessingReward(sim, by('rpg_pickBlessingReward'));
        if (first('rpg_dcConfirm')) return first('rpg_dcConfirm');
        if (by('rpg_pickDarkContract').length) return this.darkContract(sim, by('rpg_pickDarkContract')) || first('rpg_skipDarkContract');
        if (first('rpg_forgeConfirm')) return first('rpg_forgeConfirm');
        if (by('rpg_celestialForge').length) return by('rpg_celestialForge').filter(a => !a.disabled).pop() || any('rpg_skipForge', 'rpg_proceed');
        if (by('rpg_forgeItem').length) { const f = by('rpg_forgeItem').find(a => !a.disabled); return f || any('rpg_skipForge', 'rpg_proceed'); }
        if (first('rpg_forgeRetry')) return first('rpg_forgeRetry');
        if (by('rpg_buyMerchant').length || first('rpg_leaveMerchant')) return this.merchant(sim, by('rpg_buyMerchant')) || any('rpg_leaveMerchant', 'rpg_proceed');
        return any('rpg_proceed', 'rpg_skipForge', 'rpg_skipChest', 'rpg_skipDarkContract', 'rpg_leaveMerchant', 'rpg_questProceed') || acts[0];
    }

    battle(sim, acts) {
        const p = sim.g.player, enemy = sim.g.enemy;
        const hpR = this.hpR(p);
        const SK = sim.fn('SKILL_DEFS');
        const ready = acts.filter(a => a.name === 'rpg_action' && !a.disabled);
        const proceed = acts.find(a => a.name !== 'rpg_action');
        if (!ready.length) return proceed || acts[0];
        const keys = new Map(ready.map(a => [a.args[0], a]));
        // 포션(턴 소모 없음)
        if (hpR < this.opts.potionBattleHp && enemy && enemy.hp > 0) {
            const pk = this.usePotion(sim, true);
            if (pk && keys.has(pk)) return keys.get(pk);
        }
        const skills = ready.map(a => a.args[0]).filter(k => SK[k]);
        const free = skills.filter(k => SK[k].freeTurn && !SK[k]._autoEndTurn);
        const tags = k => SK[k].tags || [];
        // 회복 스킬
        for (const k of free) if (tags(k).includes('회복') && hpR < this.opts.healSkillHp) return keys.get(k);
        // 무료 버프/디버프 (HP 소모형은 HP가 넉넉할 때만)
        for (const k of free) {
            if (tags(k).includes('회복')) continue;
            if ((k === 'bloodPact' || k === 'frenzy') && hpR < 0.6) continue;
            return keys.get(k);
        }
        // 보스 강공격 예고(다음 적 턴에 최대HP 70% 고정 피해, 방어 시 20%) → 방어. 이번 턴에 확실히 잡을 수 있으면 공격.
        const charging = enemy && enemy._bossCharging && keys.has('defend') && this.opts.defendCharge !== false;
        // 궁극기 → 기대 피해 최대 스킬 → 기본 공격
        let best = null, bestV = 0;
        for (const k of skills) {
            if (SK[k].freeTurn) continue;
            if (['bloodStrike', 'crimsonDrain', 'berserkerRage', 'bloodStrike_ult'].includes(k) && hpR < 0.4) continue;
            if (k === 'lifeGamble' && hpR < 0.6) continue;
            let v = this.skillValue(sim, k);
            if (v <= 0) v = hpR < 0.7 ? 6 : 0.5; // 비피해 유틸(응수·덩굴 등)은 위험할 때만 선호
            if (v > bestV) { bestV = v; best = k; }
        }
        if (charging && !(enemy.hp + (enemy.shield || 0) < Math.max(bestV, 1) * 0.6)) return keys.get('defend');
        if (best && bestV >= 1) return keys.get(best);
        return keys.get('attack') || ready[0];
    }

    door(sim, doors) {
        const gs = sim.g.gameState, p = sim.g.player;
        const hpR = this.hpR(p);
        const danger = 1 + 2.5 * (1 - hpR);
        let best = null, bestS = -1e9;
        for (const a of doors) {
            const type = gs.doorChoices[a.args[0]];
            let [rew, risk] = DOOR_SCORE[type] || [1, 1];
            if (type === 'dragon_nest') {
                // 'always': HP 80% 이상이면 진입, 'strong': 레벨이 층+2 이상이고 HP 90% 이상, 'never': 회피
                const dn = this.opts.dragonNest;
                const ok = dn === 'always' ? hpR >= 0.8 : dn === 'strong' ? (hpR >= 0.9 && p.level >= gs.floor + 2) : false;
                if (!ok) rew = -10;
            }
            if (type === 'cursed' && hpR < 0.7) rew = 0;
            if (type === 'barrier' && hpR < 0.6) rew += 2;
            const s = rew - risk * danger;
            if (s > bestS) { bestS = s; best = a; }
        }
        return best || doors[0];
    }

    mutation(sim, acts) {
        const choices = sim.ev('_mutationChoices') || [];
        const picks = acts.filter(a => a.name === 'rpg_pickMutation');
        for (const id of MUTATION_PREF) {
            const i = choices.findIndex(m => m && m.id === id);
            if (i >= 0) { const a = picks.find(x => x.args[0] === i); if (a) return a; }
        }
        return acts.find(a => a.name === 'rpg_skipMutation') || acts[0];
    }

    golden(sim, picks) {
        const ch = sim.g.goldenChoices || [];
        const rank = {equip: 3, stats: 2, goldexp: 1};
        return picks.slice().sort((a, b) => (rank[(ch[b.args[0]] || {}).type] || 0) - (rank[(ch[a.args[0]] || {}).type] || 0))[0];
    }
    owned(sim) {
        const set = new Set();
        for (const e of sim.fn('getAllOwnedEquipment')(sim.g.player)) set.add(e.id);
        return set;
    }
    legendAltar(sim, picks) {
        const ch = sim.g.gameState._legendaryBlessingChoices || [], own = this.owned(sim);
        return picks.find(a => ch[a.args[0]] && !own.has(ch[a.args[0]].id)) || picks[0];
    }
    pickLegendaryStart(sim, picks) {
        const DB = sim.fn('EQUIP_DB');
        const score = id => { const e = DB.find(x => x.id === id); return e ? (e.passive ? 10 : 0) + Object.values(e.bonuses || {}).reduce((s, v) => s + v, 0) : 0; };
        return picks.slice().sort((a, b) => score(b.args[0]) - score(a.args[0]))[0];
    }
    pickPassive(sim, picks) {
        const PD = sim.fn('PASSIVE_DEFS'), PR = {common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, mythic: 6};
        return picks.slice().sort((a, b) => (PR[(PD[b.args[0]] || {}).rarity] || 0) - (PR[(PD[a.args[0]] || {}).rarity] || 0))[0];
    }
    pickSkill(sim, picks) {
        const SK = sim.fn('SKILL_DEFS'), R = {common: 1, uncommon: 2, rare: 3, epic: 4};
        const v = k => (R[(SK[k] || {}).rarity] || 0) * 100 + this.skillValue(sim, k);
        return picks.slice().sort((a, b) => v(b.args[0]) - v(a.args[0]))[0];
    }
    blessingReward(sim, picks) {
        const rw = sim.g.gameState.blessingRewards || [];
        const rank = {passive: 4, stat: 3, exp: 2, gold: 1};
        return picks.slice().sort((a, b) => (rank[(rw[b.args[0]] || {}).type] || 0) - (rank[(rw[a.args[0]] || {}).type] || 0))[0];
    }
    darkContract(sim, picks) {
        const p = sim.g.player, ch = sim.g.gameState.darkContractChoices || [];
        if (this.hpR(p) < 0.75) return null;
        const own = this.owned(sim);
        const val = c => {
            const r = c.reward || {};
            if (r.type === 'equip') return own.has(r.equip && r.equip.id) ? 0 : (RARITY_SCORE[r.equip && r.equip.rarity] || 1) * 2;
            if (r.type === 'passive') return 7;
            if (r.type === 'skill') return p.skills.includes(r.key) ? 0 : 6;
            if (r.type === 'stat') return 4 + (r.amount || 0);
            if (r.type === 'exp') return 3;
            return 1;
        };
        let best = null, bv = 0;
        for (const a of picks) { const c = ch[a.args[0]]; if (!c) continue; const v = val(c) / (1 + (c.hpCostPct || 0) / 20); if (v > bv) { bv = v; best = a; } }
        return best;
    }
    merchant(sim, buys) {
        const gs = sim.g.gameState, p = sim.g.player, offers = gs.merchantOffers || [];
        const own = this.owned(sim);
        const potions = POTION_ORDER.reduce((s, k) => s + ((p.potionInventory || {})[k] || 0), 0);
        const wantPot = 2 + Math.floor(gs.floor / 3);
        let best = null, bv = 0;
        for (const a of buys) {
            const o = offers[a.args[0]];
            if (!o || o.sold || o.cost > p.gold) continue;
            let v = 0;
            if (o.type === 'potion') v = potions < wantPot ? 9 : 1;
            else if (o.type === 'equip') v = own.has(o.equip && o.equip.id) ? 0 : (RARITY_SCORE[o.equip && o.equip.rarity] || 1) * 1.6;
            else if (o.type === 'skill') v = p.skills.includes(o.key) ? 0 : 6;
            else if (o.type === 'deathSave') v = p.gold >= o.cost + 150 ? 5 : 0;
            else if (o.type === 'statBook') v = 3;
            else if (o.type === 'mysteryBox') v = p.gold >= o.cost * 2 ? 2 : 0;
            if (v > bv) { bv = v; best = a; }
        }
        return bv >= 1.5 ? best : null;
    }
}

module.exports = {Policy, diceAvg, DOOR_SCORE, RARITY_SCORE};
