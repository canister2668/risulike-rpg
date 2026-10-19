#!/usr/bin/env node
'use strict';
// 시뮬레이션 JSONL을 집계해 마크다운 표로 출력한다.
// 예) node tools/sim/analyze.cjs sim-out/before/base.jsonl > sim-out/before/report.md
//     node tools/sim/analyze.cjs --json sim-out/before/base.jsonl   (요약 JSON)
const fs = require('node:fs');
const path = require('node:path');

const CLASS_KO = {warrior: '기사', rogue: '도적', mage: '마녀', cleric: '성녀', hunter: '사냥꾼', dhampir: '하프뱀파이어', paladin: '팔라딘', druid: '드루이드', berserker: '광전사', madman: '광대', bard: '음유시인', princess: '공주', necro: '강령술사', monk: '무도가', alchemist: '연금술사', succubus: '서큐버스'};
const DIFF_KO = {1: '쉬움', 2: '보통', 3: '어려움', 4: '악몽', 5: '지옥', 6: '나락'};

function load(files) {
    const out = [];
    for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (line.trim()) out.push(JSON.parse(line));
    return out;
}
function wilson(k, n, z = 1.96) {
    if (!n) return [0, 0];
    const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [(c - m) / d, (c + m) / d];
}
const pct = (x, d = 1) => (100 * x).toFixed(d);
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const reached = (r, f) => r.cleared || r.floor >= f;
function groupBy(arr, fn) { const m = new Map(); for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }

function loadNames() {
    // 게임 소스에서 이름 사전(적/패시브/장비/스킬)을 읽는다.
    try {
        const {Sim} = require('./engine.cjs');
        const sim = new Sim(); sim.reset(1);
        const ET = sim.fn('ENEMY_TEMPLATES'), PD = sim.fn('PASSIVE_DEFS'), DB = sim.fn('EQUIP_DB'), SK = sim.fn('SKILL_DEFS');
        const eq = {}; for (const e of DB) eq[e.id] = {name: e.name, rarity: e.rarity, passive: e.passive || null};
        const en = {}; for (const k in ET) en[k] = {name: ET[k].name, boss: ET[k].boss, elite: ET[k].elite};
        const pa = {}; for (const k in PD) pa[k] = {name: PD[k].name, rarity: PD[k].rarity};
        const sk = {}; for (const k in SK) sk[k] = {name: SK[k].name};
        return {eq, en, pa, sk};
    } catch (e) { return {eq: {}, en: {}, pa: {}, sk: {}}; }
}

function summarize(runs) {
    const S = {n: runs.length, byDiff: {}, byCell: {}, byClass: {}};
    for (const [d, rs] of groupBy(runs, r => r.diff)) {
        const k = rs.filter(r => r.cleared).length;
        S.byDiff[d] = {n: rs.length, clear: k / rs.length, ci: wilson(k, rs.length), floor: mean(rs.map(r => r.cleared ? 10 : r.floor)),
            actions: mean(rs.map(r => r.battleActions)), rooms: mean(rs.map(r => r.rooms)), level: mean(rs.map(r => r.level)),
            softlocks: rs.reduce((s, r) => s + (r.softlocks || 0), 0), stuck: rs.filter(r => r.stuck).length};
    }
    for (const [key, rs] of groupBy(runs, r => r.cls + '|' + r.diff)) {
        const k = rs.filter(r => r.cleared).length;
        S.byCell[key] = {n: rs.length, clear: k / rs.length, ci: wilson(k, rs.length), floor: mean(rs.map(r => r.cleared ? 10 : r.floor))};
    }
    for (const [c, rs] of groupBy(runs, r => r.cls)) {
        const k = rs.filter(r => r.cleared).length;
        S.byClass[c] = {n: rs.length, clear: k / rs.length};
    }
    return S;
}

// 생존 편향 보정: 같은 (직업, 난이도)에서 f층에 도달한 런의 클리어율을 기대값으로 쓴다.
function reachTable(runs) {
    const T = new Map();
    for (const [key, rs] of groupBy(runs, r => r.cls + '|' + r.diff)) {
        const arr = [];
        for (let f = 0; f <= 10; f++) {
            const reach = rs.filter(r => reached(r, Math.max(1, f)));
            arr[f] = reach.length ? reach.filter(r => r.cleared).length / reach.length : 0;
        }
        T.set(key, arr);
    }
    return T;
}
function adoption(runs, field, minN) {
    const T = reachTable(runs);
    const acc = new Map();
    for (const r of runs) {
        const seen = new Set();
        for (const [id, f] of r[field] || []) {
            if (seen.has(id)) continue; seen.add(id);
            if (field === 'equips' && f === 0) continue; // 시작 장비 제외
            const p = T.get(r.cls + '|' + r.diff)[Math.min(10, Math.max(1, f))];
            if (!acc.has(id)) acc.set(id, {n: 0, obs: 0, exp: 0, var: 0, floors: 0});
            const a = acc.get(id);
            a.n++; a.obs += r.cleared ? 1 : 0; a.exp += p; a.var += p * (1 - p); a.floors += f;
        }
    }
    const rows = [];
    for (const [id, a] of acc) {
        if (a.n < minN) continue;
        const z = a.var > 0 ? (a.obs - a.exp) / Math.sqrt(a.var) : 0;
        rows.push({id, n: a.n, obs: a.obs / a.n, exp: a.exp / a.n, lift: (a.obs - a.exp) / a.n, z, floor: a.floors / a.n});
    }
    return rows.sort((x, y) => y.z - x.z);
}

function report(runs, names, opts = {}) {
    const L = [];
    const S = summarize(runs);
    const diffs = Object.keys(S.byDiff).map(Number).sort();
    const classes = [...new Set(runs.map(r => r.cls))];
    L.push(`총 ${runs.length}런 (직업 ${classes.length} × 난이도 ${diffs.length})`);
    L.push('');
    L.push('### 난이도별 요약');
    L.push('');
    L.push('| 난이도 | 런 | 클리어율 (95% CI) | 평균 도달 층 | 평균 레벨 | 전투 행동/런 | 방/런 | 소프트락 |');
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const d of diffs) {
        const x = S.byDiff[d];
        L.push(`| ${d} ${DIFF_KO[d]} | ${x.n} | ${pct(x.clear)}% (${pct(x.ci[0])}–${pct(x.ci[1])}) | ${x.floor.toFixed(2)} | ${x.level.toFixed(1)} | ${x.actions.toFixed(0)} | ${x.rooms.toFixed(0)} | ${x.softlocks} |`);
    }
    L.push('');
    L.push('### 직업 × 난이도 클리어율 (%)');
    L.push('');
    L.push('| 직업 | ' + diffs.map(d => DIFF_KO[d]).join(' | ') + ' | 1~4 평균 | 평균 도달 층(1~6) |');
    L.push('|---|' + diffs.map(() => '---:').join('|') + '|---:|---:|');
    const clsRows = classes.map(c => {
        const cells = diffs.map(d => S.byCell[c + '|' + d]);
        const avg14 = mean(diffs.filter(d => d <= 4).map(d => S.byCell[c + '|' + d].clear));
        return {c, cells, avg14, floor: mean(cells.map(x => x.floor))};
    }).sort((a, b) => b.avg14 - a.avg14);
    for (const r of clsRows) L.push(`| ${CLASS_KO[r.c] || r.c} | ` + r.cells.map(x => pct(x.clear, 0)).join(' | ') + ` | ${pct(r.avg14)} | ${r.floor.toFixed(2)} |`);
    const n0 = S.byCell[classes[0] + '|' + diffs[0]].n;
    L.push('');
    L.push(`칸당 ${n0}런. p=50%일 때 95% 신뢰구간 폭은 약 ±${pct(1.96 * Math.sqrt(0.25 / n0), 0)}%p.`);
    L.push('');
    L.push('### 사망 층 분포 (사망 런 중 비율 %) · 층별 사망 위험');
    L.push('');
    L.push('사망 위험 = 그 층에 도달한 런 중 그 층에서 사망한 비율.');
    L.push('');
    L.push('| 난이도 | ' + [...Array(10)].map((_, i) => `${i + 1}F`).join(' | ') + ' |');
    L.push('|---|' + [...Array(10)].map(() => '---:').join('|') + '|');
    for (const d of diffs) {
        const rs = runs.filter(r => r.diff === d), dead = rs.filter(r => r.death);
        const dist = [...Array(10)].map((_, i) => dead.filter(r => r.floor === i + 1).length / Math.max(1, dead.length));
        L.push(`| ${DIFF_KO[d]} 분포 | ` + dist.map(x => pct(x, 0)).join(' | ') + ' |');
        const haz = [...Array(10)].map((_, i) => { const reach = rs.filter(r => reached(r, i + 1)); return reach.length ? dead.filter(r => r.floor === i + 1).length / reach.length : NaN; });
        L.push(`| ${DIFF_KO[d]} 위험 | ` + haz.map(x => isNaN(x) ? '–' : pct(x, 0)).join(' | ') + ' |');
    }
    L.push('');
    L.push('### 사망 원인 상위 적');
    L.push('');
    const dead = runs.filter(r => r.death);
    const enc = {};
    for (const r of runs) for (const k in r.encounters) enc[k] = (enc[k] || 0) + r.encounters[k];
    const dc = {};
    for (const r of dead) dc[r.death] = (dc[r.death] || 0) + 1;
    const top = Object.entries(dc).sort((a, b) => b[1] - a[1]).slice(0, opts.topEnemies || 15);
    L.push('| 적 | 구분 | 사망 수 | 전체 사망 중 % | 조우 수 | 조우당 치사율 |');
    L.push('|---|---|---:|---:|---:|---:|');
    for (const [k, v] of top) {
        const nm = names.en[k] || {};
        const kind = k === 'BOT_BOSS' ? '봇 보스' : nm.boss ? '보스' : nm.elite ? '엘리트' : k.startsWith('event:') ? '이벤트' : '일반';
        L.push(`| ${nm.name || k} (\`${k}\`) | ${kind} | ${v} | ${pct(v / dead.length)} | ${enc[k] || '–'} | ${enc[k] ? pct(v / enc[k]) + '%' : '–'} |`);
    }
    L.push('');
    L.push('난이도별 상위 3: ' + diffs.map(d => {
        const c = {}; for (const r of dead.filter(x => x.diff === d)) c[r.death] = (c[r.death] || 0) + 1;
        const n = dead.filter(x => x.diff === d).length;
        return `**${DIFF_KO[d]}** ` + Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${(names.en[k] || {}).name || k} ${pct(v / Math.max(1, n), 0)}%`).join(', ');
    }).join(' · '));
    if (opts.items !== false) {
        for (const [field, label, dict] of [['passives', '패시브(획득형)', names.pa], ['equips', '장비', names.eq]]) {
            const rows = adoption(runs, field, opts.minN || 40);
            L.push('');
            L.push(`### ${label} 채택 시 클리어율 이상치`);
            L.push('');
            L.push(`기대 클리어율 = 같은 직업·난이도에서 획득 층에 도달한 런의 클리어율(생존 편향 보정). |z| ≥ 3, 채택 ${opts.minN || 40}런 이상만. 분석 대상 ${rows.length}개.`);
            L.push('');
            L.push('| 항목 | 희귀도 | 채택 런 | 평균 획득 층 | 관측 클리어율 | 기대 | 차이 | z |');
            L.push('|---|---|---:|---:|---:|---:|---:|---:|');
            const outl = rows.filter(r => Math.abs(r.z) >= 3);
            for (const r of outl) {
                const nm = dict[r.id] || {};
                L.push(`| ${nm.name || r.id} (\`${r.id}\`) | ${nm.rarity || '–'} | ${r.n} | ${r.floor.toFixed(1)} | ${pct(r.obs)}% | ${pct(r.exp)}% | ${r.lift >= 0 ? '+' : ''}${pct(r.lift)}%p | ${r.z.toFixed(1)} |`);
            }
            if (!outl.length) L.push('| (없음) | | | | | | | |');
        }
    }
    return {md: L.join('\n'), S};
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const files = args.filter(a => !a.startsWith('--'));
    const runs = load(files);
    const names = loadNames();
    const {md, S} = report(runs, names, {});
    if (json) console.log(JSON.stringify(S, null, 1)); else console.log(md);
}

module.exports = {load, wilson, summarize, report, adoption, loadNames, groupBy, mean, pct, CLASS_KO, DIFF_KO, reached};
void path;
